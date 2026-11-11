// Controlador de una partida en directo en el navegador (sin React; dependencias inyectadas).
// - Avanza la partida con POST /api/games/[id]/advance: UNA petición a la vez, solo cuando lo
//   recibido ya se ha mostrado (animación terminada) y tras una pausa. El servidor garantiza que
//   una versión no se avanza dos veces (versión + reserva); aquí se evita además pedirlo en vano.
// - Recibe versiones de Realtime (otros espectadores), de la respuesta de advance y de GET (resync).
// - Se detiene: al terminar la partida, con la pestaña oculta (pausa) y al desmontar (stop).

import type { TurnLogEntry } from "@/components/hud/TurnLog";
import { describeEvent } from "@/lib/hud/events";
import { GameResponseSchema, type GameResponse } from "./api";
import { CHARACTER_NAMES } from "./characters";
import {
  initLive,
  interpretAdvance,
  isCaughtUp,
  parseRealtimeRow,
  receive,
  retryAfterMs,
  retryDelay,
  takeDisplayStep,
  type DisplayStep,
  type LiveModel,
} from "./live";

export type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface RealtimeHandlers {
  onRow: (row: unknown) => void;
  onStatus: (status: RealtimeStatus) => void;
}

export interface LiveDeps {
  fetch: typeof fetch;
  /** Se suscribe a los cambios de la fila; devuelve la función para cancelar la suscripción. */
  subscribe: (gameId: string, handlers: RealtimeHandlers) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface LiveOptions {
  /** Pausa entre una acción mostrada y la siguiente petición (ritmo de la partida). */
  pauseMs?: number;
  /** Espera tras un 409 turn_in_progress / lease_expired. */
  waitMs?: number;
  /** Tras un 409 version_conflict con Realtime conectado: margen para que llegue la versión antes de hacer GET. */
  realtimeGraceMs?: number;
}

export type Connection =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting" }
  /** Pestaña oculta: no se avanza. */
  | { kind: "paused" }
  | { kind: "retrying"; message: string; failures: number }
  | { kind: "finished" }
  | { kind: "error"; message: string };

export interface LiveView {
  /** Versión mostrada (el HUD la usa; el tablero la anima). */
  display: GameResponse;
  /** Versión más alta conocida. */
  latest: GameResponse;
  /**
   * Versión que el tablero ya ha terminado de dibujar (animación acabada). El chat solo muestra
   * mensajes de versiones ≤ esta, para no adelantar acontecimientos que aún no se han visto.
   */
  boardVersion: number;
  /** Paso pendiente de animar (cambia `seq` en cada uno); null si no hay nada que animar. */
  animation: { seq: number; step: DisplayStep } | null;
  connection: Connection;
  /** Versión de la última tirada mostrada (reinicia la animación del dado). */
  lastRollVersion: number;
  /** Eventos de las últimas versiones mostradas, del más reciente al más antiguo. */
  log: TurnLogEntry[];
}

const LOG_SIZE = 8;

export class LiveGameController {
  private model: LiveModel;
  private view: LiveView;
  private listeners = new Set<() => void>();
  private stopped = true;
  private visible = true;
  private realtimeUp = false;
  private inFlight: AbortController | null = null;
  private timer: unknown = null;
  private failures = 0;
  private nextDelay: number | null = null;
  private seq = 0;
  private unsubscribe: (() => void) | null = null;
  /** Versión que se espera recibir por Realtime tras un 409 (mientras, no se piden avances). */
  private awaitingVersion: number | null = null;
  private graceTimer: unknown = null;
  private readonly pauseMs: number;
  private readonly waitMs: number;
  private readonly realtimeGraceMs: number;

  constructor(
    initial: GameResponse,
    private readonly deps: LiveDeps,
    options: LiveOptions = {},
  ) {
    this.pauseMs = options.pauseMs ?? 450;
    this.waitMs = options.waitMs ?? 1000;
    this.realtimeGraceMs = options.realtimeGraceMs ?? 400;
    this.model = initLive(initial);
    this.view = {
      display: initial,
      latest: initial,
      boardVersion: initial.version,
      animation: null,
      connection: initial.status === "finished" ? { kind: "finished" } : { kind: "connecting" },
      lastRollVersion: initial.lastAction?.type === "roll" ? initial.version : 0,
      log: describeVersion(initial),
    };
  }

  // ─── API para React (useSyncExternalStore) ────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.view;

  /** Empieza: suscripción a Realtime y bucle de avance (no hace nada si la partida ya terminó). */
  start() {
    if (!this.stopped || this.model.latest.status === "finished") return;
    this.stopped = false;
    this.unsubscribe = this.deps.subscribe(this.model.latest.id, {
      onRow: (row) => this.onRealtimeRow(row),
      onStatus: (status) => this.onRealtimeStatus(status),
    });
    this.schedule();
  }

  /** Detiene todo: cancela la petición en curso, los temporizadores y la suscripción. */
  stop() {
    this.stopped = true;
    this.inFlight?.abort();
    this.inFlight = null;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.clearAwaiting();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Pestaña visible u oculta: con la pestaña oculta no se piden avances. */
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.stopped) return;
    if (!visible) {
      if (this.timer !== null) this.deps.clearTimeout(this.timer);
      this.timer = null;
      this.updateConnection();
      return;
    }
    this.updateConnection();
    void this.resync(); // al volver, ponerse al día antes de seguir
  }

  /** El navegador ha recuperado la red: ponerse al día enseguida (sin esperar al reintento). */
  networkRestored() {
    if (!this.stopped) void this.resync();
  }

  /** La vista ha terminado de animar el paso actual. */
  animationDone(seq: number) {
    if (this.view.animation?.seq !== seq) return;
    this.setView({ animation: null, boardVersion: this.view.display.version });
    this.advanceDisplay();
    this.schedule();
  }

  // ─── Entradas ─────────────────────────────────────────────────────────────

  private onRealtimeRow(row: unknown) {
    if (this.stopped) return;
    const game = parseRealtimeRow(row);
    if (game) this.accept(game);
  }

  private onRealtimeStatus(status: RealtimeStatus) {
    if (this.stopped) return;
    this.realtimeUp = status === "SUBSCRIBED";
    this.updateConnection();
    // (Re)suscrito: recuperar lo que se haya podido perder mientras no había suscripción.
    if (this.realtimeUp) void this.resync();
  }

  private accept(game: GameResponse) {
    this.model = receive(this.model, game);
    if (this.awaitingVersion !== null && this.model.latest.version >= this.awaitingVersion) this.clearAwaiting();
    this.setView({ latest: this.model.latest });
    this.advanceDisplay();
    this.schedule();
  }

  /** Muestra la siguiente versión pendiente (si no se está animando ya otra). */
  private advanceDisplay() {
    if (this.view.animation) return;
    const next = takeDisplayStep(this.model);
    if (!next) {
      // Fechas refrescadas de la versión mostrada (misma versión).
      if (this.view.display !== this.model.display) this.setView({ display: this.model.display });
      this.updateConnection();
      return;
    }
    this.model = next.model;
    const to = next.step.to;
    this.setView({
      display: to,
      animation: { seq: ++this.seq, step: next.step },
      lastRollVersion: to.lastAction?.type === "roll" ? to.version : this.view.lastRollVersion,
      log: next.step.kind === "animate" ? [...describeVersion(to), ...this.view.log].slice(0, LOG_SIZE) : describeVersion(to),
    });
    if (to.status === "finished" && isCaughtUp(this.model)) this.finish();
  }

  private finish() {
    this.updateConnection();
    // Fechas definitivas (finished_at) antes de soltar la suscripción.
    void this.resync().finally(() => this.stop());
  }

  // ─── Bucle de avance ──────────────────────────────────────────────────────

  private canAdvance() {
    return (
      !this.stopped &&
      this.visible &&
      this.inFlight === null &&
      this.view.animation === null &&
      this.awaitingVersion === null &&
      isCaughtUp(this.model) &&
      this.model.latest.status === "playing" &&
      this.view.connection.kind !== "error"
    );
  }

  private schedule() {
    if (this.timer !== null || !this.canAdvance()) return;
    const delay = this.nextDelay ?? this.pauseMs;
    this.nextDelay = null;
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      if (this.canAdvance()) void this.requestAdvance();
    }, delay);
  }

  private async requestAdvance() {
    const current = this.model.latest;
    const controller = new AbortController();
    this.inFlight = controller;
    let outcome;
    try {
      const response = await this.deps.fetch(`/api/games/${current.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: current.version }),
        cache: "no-store",
        signal: controller.signal,
      });
      outcome = interpretAdvance(
        response.status,
        await response.json().catch(() => null),
        current,
        response.headers.get("Retry-After"),
      );
    } catch {
      if (controller.signal.aborted) return; // stop(): no tocar nada
      outcome = { kind: "retry" as const, message: "Sin conexión con el servidor." };
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    if (this.stopped) return;

    switch (outcome.kind) {
      case "update":
        this.failures = 0;
        this.accept(outcome.game);
        break;
      case "resync": {
        this.failures = 0;
        const target = outcome.currentVersion;
        if (target !== undefined && this.model.latest.version >= target) break; // Realtime ya la entregó
        if (target !== undefined && this.realtimeUp) {
          // Otro espectador acaba de avanzar: su versión suele llegar por Realtime en unos cientos
          // de ms. Se espera ese margen antes de recurrir al GET (evita un GET por versión).
          this.awaitingVersion = target;
          this.graceTimer = this.deps.setTimeout(() => {
            this.graceTimer = null;
            if (this.awaitingVersion !== null && this.model.latest.version < this.awaitingVersion) {
              this.awaitingVersion = null;
              void this.resync();
            }
          }, this.realtimeGraceMs);
        } else {
          await this.resync();
        }
        break;
      }
      case "wait":
        this.failures = 0;
        this.nextDelay = this.waitMs;
        break;
      case "retry":
        this.failures++;
        this.nextDelay = outcome.delayMs ?? retryDelay(this.failures);
        this.setView({ connection: { kind: "retrying", message: outcome.message, failures: this.failures } });
        break;
      case "fatal":
        this.setView({ connection: { kind: "error", message: outcome.message } });
        this.stop();
        return;
    }
    if (outcome.kind !== "retry") this.updateConnection();
    this.schedule();
  }

  /** Pide la última versión con GET (tras conflictos, reconexiones o al volver a la pestaña). */
  private async resync() {
    if (this.stopped) return;
    try {
      const response = await this.deps.fetch(`/api/games/${this.model.latest.id}`, { cache: "no-store" });
      if (this.stopped) return;
      if (response.status === 404) {
        this.setView({ connection: { kind: "error", message: "La partida ya no existe." } });
        this.stop();
        return;
      }
      const parsed = GameResponseSchema.safeParse(await response.json().catch(() => null));
      if (response.ok && parsed.success) {
        this.connectionRecovered();
        this.accept(parsed.data);
      } else {
        this.failures++;
        // 429: esperar lo que indique el servidor.
        this.nextDelay = (response.status === 429 && retryAfterMs(response.headers.get("Retry-After"))) || retryDelay(this.failures);
      }
    } catch {
      if (!this.stopped) this.nextDelay = retryDelay(++this.failures);
    }
    this.schedule();
  }

  private clearAwaiting() {
    this.awaitingVersion = null;
    if (this.graceTimer !== null) this.deps.clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /**
   * El servidor vuelve a responder: se anula la espera creciente pendiente para avanzar enseguida
   * (sin esto, tras un corte se esperaba hasta 15 s aunque la red ya hubiera vuelto).
   */
  private connectionRecovered() {
    if (this.failures === 0) return;
    this.failures = 0;
    this.nextDelay = null;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.setView({ connection: this.realtimeUp ? { kind: "live" } : { kind: "reconnecting" } });
  }

  // ─── Estado de la vista ───────────────────────────────────────────────────

  private updateConnection() {
    const finished = this.model.display.status === "finished" && isCaughtUp(this.model);
    const current = this.view.connection;
    let connection: Connection;
    if (current.kind === "error") return;
    else if (finished) connection = { kind: "finished" };
    else if (!this.visible) connection = { kind: "paused" };
    else if (current.kind === "retrying" && this.failures > 0) return;
    else if (this.realtimeUp) connection = { kind: "live" };
    else connection = this.view.connection.kind === "connecting" ? { kind: "connecting" } : { kind: "reconnecting" };
    if (connection.kind !== current.kind) this.setView({ connection });
  }

  private setView(patch: Partial<LiveView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Eventos de una versión como entradas del registro (más reciente primero). */
function describeVersion(game: GameResponse): TurnLogEntry[] {
  return game.lastEvents
    .map((event) => describeEvent(event, CHARACTER_NAMES))
    .filter((text): text is string => text !== null)
    .reverse()
    .map((text, i) => ({ id: game.version * 100 + i, text }));
}
