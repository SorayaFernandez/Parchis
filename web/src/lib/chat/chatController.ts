// Chat en directo en el navegador (sin React; dependencias inyectadas).
// - Recibe los mensajes nuevos por Realtime (INSERT en `public.game_messages`).
// - Al (re)suscribirse, al volver a la pestaña o al recuperar la red, pide con
//   GET /api/games/[id]/messages?after=<último id> todo lo posterior (por páginas), así que no se
//   pierde nada aunque Realtime se corte. Los duplicados se descartan por id.
// - Partida terminada con versiones aún pendientes (`pending`, p. ej. porque un procesador se
//   interrumpió): vuelve a consultar con espera creciente hasta que no quede nada; cada consulta
//   pone en marcha el procesador en el servidor. Así se recupera aunque ya no lleguen avances.
// Es independiente del controlador de la partida: si el chat falla, la partida sigue.

import { retryAfterMs, retryDelay } from "@/lib/game/live";
import { CHAT_LIMITS } from "./config";
import { maxMessageId, mergeMessages } from "./feed";
import { ChatMessageRowSchema, ChatPageSchema, toChatMessage, type ChatMessage } from "./schemas";

export type ChatRealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface ChatRealtimeHandlers {
  onRow: (row: unknown) => void;
  onStatus: (status: ChatRealtimeStatus) => void;
}

export interface ChatDeps {
  fetch: typeof fetch;
  subscribe: (gameId: string, handlers: ChatRealtimeHandlers) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ChatView {
  /** Todos los mensajes recibidos, en orden (la vista filtra por la versión del tablero). */
  messages: readonly ChatMessage[];
}

/** Páginas como mucho por recuperación (100 mensajes cada una). */
const MAX_PAGES = 5;

export class LiveChatController {
  private view: ChatView;
  private listeners = new Set<() => void>();
  private lastId: number;
  private stopped = true;
  private unsubscribe: (() => void) | null = null;
  private inFlight: AbortController | null = null;
  /** Se pidió otra recuperación mientras había una en curso. */
  private again = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private finished = false;
  /** Último `pending` del servidor (desconocido hasta la primera consulta). */
  private pending: boolean | null = null;
  private pendingPolls = 0;

  constructor(
    private readonly gameId: string,
    initial: readonly ChatMessage[],
    private readonly deps: ChatDeps,
  ) {
    const messages = mergeMessages([], initial);
    this.view = { messages };
    this.lastId = maxMessageId(messages);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.view;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.deps.subscribe(this.gameId, {
      onRow: (row) => this.onRow(row),
      onStatus: (status) => {
        if (!this.stopped && status === "SUBSCRIBED") void this.catchUp();
      },
    });
  }

  stop() {
    this.stopped = true;
    this.inFlight?.abort();
    this.inFlight = null;
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * La partida ha terminado (o se ha abierto ya terminada). Se consulta una vez pasado un momento
   * (el último procesador puede estar en marcha) y, mientras queden pendientes, con espera creciente.
   */
  setFinished(finished: boolean) {
    if (finished === this.finished) return;
    this.finished = finished;
    if (finished && !this.stopped && this.pending !== false) this.schedule(CHAT_LIMITS.pendingPollMs);
  }

  /** Pestaña visible de nuevo o red recuperada: recuperar lo que se haya perdido. */
  resync() {
    if (!this.stopped) void this.catchUp();
  }

  private onRow(row: unknown) {
    if (this.stopped) return;
    const parsed = ChatMessageRowSchema.safeParse(row);
    if (!parsed.success || parsed.data.game_id !== this.gameId) return;
    this.add([toChatMessage(parsed.data)]);
  }

  private add(incoming: readonly ChatMessage[]) {
    this.lastId = maxMessageId(incoming, this.lastId);
    const messages = mergeMessages(this.view.messages, incoming);
    if (messages === this.view.messages) return;
    this.view = { messages };
    for (const listener of this.listeners) listener();
  }

  /** Pide todos los mensajes posteriores al último id recibido. */
  private async catchUp(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.retryTimer !== null) {
      this.deps.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const controller = new AbortController();
    this.inFlight = controller;
    let retryIn: number | null = null;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await this.deps.fetch(`/api/games/${this.gameId}/messages?after=${this.lastId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (this.stopped) return;
        const body = ChatPageSchema.safeParse(await response.json().catch(() => null));
        if (!response.ok || !body.success) {
          this.failures++;
          retryIn = (response.status === 429 && retryAfterMs(response.headers.get("Retry-After"))) || retryDelay(this.failures);
          break;
        }
        this.failures = 0;
        this.add(body.data.messages);
        this.pending = body.data.pending;
        if (!body.data.hasMore) break;
      }
    } catch {
      if (controller.signal.aborted || this.stopped) return;
      retryIn = retryDelay(++this.failures);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      void this.catchUp();
    } else if (retryIn !== null) {
      this.schedule(retryIn);
    } else if (this.finished && this.pending) {
      // Partida terminada con versiones aún sin procesar: volver a mirar (cada GET las pone en marcha).
      this.schedule(Math.min(CHAT_LIMITS.pendingPollMs * 2 ** this.pendingPolls++, CHAT_LIMITS.pendingPollMaxMs));
    } else {
      this.pendingPolls = 0;
    }
  }

  private schedule(ms: number) {
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      void this.catchUp();
    }, ms);
  }
}
