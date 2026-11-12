// Procesador del chat: vacía la cola de versiones pendientes de una partida, por lotes y en orden.
//   reserva de lote → por cada versión: director → escritor → validación → confirmación del lote.
// Las versiones las encola PostgreSQL (trigger de `games`) en la misma transacción que el avance,
// así que este procesador puede ejecutarse desde cualquier sitio y cuantas veces haga falta:
// tras cada avance (after), al leer el chat (GET de mensajes) o a mano. Es idempotente: si dos
// ejecuciones coinciden, solo una obtiene la reserva; si una muere, su reserva caduca y otra sigue.
// Nunca lanza. Sin dependencias de servidor (store, escritor, azar y token se inyectan).

import type { GameEvent, GameState, PlayerId } from "@/lib/engine";
import { GameEventSchema, GameStateSchema } from "@/lib/game/schemas";
import { CHAT_LIMITS, CHAT_STORAGE } from "./config";
import { initialDirectorState, planChat, recordPublished, trackCaptures, type Random, type Utterance } from "./director";
import { DirectorStateSchema, type DirectorState } from "./schemas";
import type { ChatStore, ClaimedBatch, QueueItem, QueuedMessage } from "./store";
import { validateChatText, type ChatWriteRequest, type ChatWriter, type RecentText, type WrittenText } from "./writer";
import { z } from "zod";

export interface ChatDeps {
  store: ChatStore;
  writer: ChatWriter;
  /**
   * Escritor de reserva, local y sin red (las frases del catálogo). Obligatorio: se usa si el
   * escritor principal falla o agota su tiempo, para la victoria en modo mínimo y cuando ya no queda
   * tiempo de reserva para el principal. Con las frases locales como principal, es el mismo.
   * CONTRATO: debe responder al instante (sin red ni esperas) y no tiene tiempo máximo. Puede
   * ejecutarse justo al empezar el margen de confirmación (`commitMarginMs`): si tardara más que ese
   * margen, la reserva caducaría antes de confirmar.
   */
  fallbackWriter: ChatWriter;
  random: Random;
  newToken: () => string;
  /** Reloj (ms) para medir la reserva. Por defecto, `Date.now`. */
  now?: () => number;
  /** Temporizadores para el tiempo máximo de cada llamada. Por defecto, los globales. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Tiempo de la reserva vista por el procesador (empieza al recibir la respuesta de la reserva). */
interface LeaseClock {
  startedAt: number;
  endsAt: number;
  now: () => number;
}

/** El escritor principal superó su tiempo máximo (su llamada se ha abortado). */
export class ChatWriterTimeoutError extends Error {
  override name = "ChatWriterTimeoutError";
}

export type DrainResult =
  /** Nada pendiente, u otra ejecución tiene la reserva (ella o la siguiente lo procesarán). */
  | { kind: "idle"; batches: number; published: number }
  /** Se procesó todo lo pendiente. */
  | { kind: "done"; batches: number; published: number }
  /** Se alcanzó el máximo de lotes por ejecución: queda trabajo para la siguiente. */
  | { kind: "more"; batches: number; published: number }
  /** La reserva caducó antes de confirmar: no se guardó ese lote (sigue pendiente). */
  | { kind: "lease_expired"; batches: number; published: number }
  /** Fallo (BD, escritor…): el lote sigue pendiente y la reserva se ha liberado si se pudo. */
  | { kind: "error"; batches: number; published: number; error: unknown };

const EventsSchema = z.array(GameEventSchema);

/** Vacía la cola de la partida (como mucho `maxBatchesPerDrain` lotes). Nunca lanza. */
export async function drainChat(gameId: string, deps: ChatDeps): Promise<DrainResult> {
  let batches = 0;
  let published = 0;
  for (let i = 0; i < CHAT_LIMITS.maxBatchesPerDrain; i++) {
    const token = deps.newToken();
    let batch: ClaimedBatch | null;
    try {
      batch = await deps.store.claim(gameId, token, CHAT_LIMITS.leaseSeconds, CHAT_LIMITS.batchSize);
    } catch (error) {
      return { kind: "error", batches, published, error };
    }
    if (!batch) return { kind: batches === 0 ? "idle" : "done", batches, published };

    // El reloj local empieza tras recibir la reserva, así que va algo por detrás del de la BD: el
    // margen de confirmación (`commitMarginMs`) cubre esa diferencia.
    const now = deps.now ?? Date.now;
    const startedAt = now();
    const lease: LeaseClock = { startedAt, endsAt: startedAt + CHAT_LIMITS.leaseSeconds * 1000, now };

    try {
      const processed = await processBatch(batch, deps, lease);
      if (processed.through === null) {
        // Falló la primera versión del lote: nada que confirmar. Sigue pendiente (con un intento más).
        await deps.store.release(gameId, token).catch(() => {});
        return { kind: "error", batches, published, error: processed.error };
      }
      const { director, messages, through } = processed;
      const result = await deps.store.commit(gameId, token, through, director, messages, CHAT_LIMITS.maxMessagesPerGame);
      if (!result) return { kind: "lease_expired", batches, published };
      batches++;
      published += result.inserted;
      // Se confirmó hasta la versión anterior a la que falló: la siguiente ejecución empieza en ella.
      if (processed.error !== undefined) return { kind: "error", batches, published, error: processed.error };
      // Lo que se encoló mientras se procesaba este lote (o lo que quedó por el plazo de trabajo) se
      // recoge en la vuelta siguiente, con una reserva nueva.
      if (!result.hasMore) return { kind: "done", batches, published };
    } catch (error) {
      await deps.store.release(gameId, token).catch(() => {});
      return { kind: "error", batches, published, error };
    }
  }
  return { kind: "more", batches, published };
}

export interface ProcessedBatch {
  director: DirectorState;
  messages: QueuedMessage[];
  /** Última versión procesada (se confirma hasta ella); `null` si falló la primera. */
  through: number | null;
  /** Error de la versión en la que se detuvo (que queda pendiente), si lo hubo. */
  error?: unknown;
  /** Se detuvo por el plazo de trabajo de la reserva (lo que falta sigue pendiente, en orden). */
  stoppedByBudget?: boolean;
}

/**
 * Recorre el lote en orden y decide los mensajes de cada versión. Si una versión falla (p. ej., el
 * escritor), se detiene ahí y devuelve lo procesado hasta la anterior: así solo la versión que
 * falla acumula intentos y las siguientes no se ven afectadas.
 */
export async function processBatch(batch: ClaimedBatch, deps: ChatDeps, lease: LeaseClock = unlimitedLease()): Promise<ProcessedBatch> {
  const parsedState = DirectorStateSchema.safeParse(batch.directorState);
  let director = parsedState.success ? parsedState.data : initialDirectorState();
  const messages: QueuedMessage[] = [];
  let through: number | null = null;

  const budget = (lease.endsAt - lease.startedAt) * CHAT_LIMITS.workBudgetFraction;
  for (const item of batch.items) {
    // Plazo de trabajo: pasada la mitad de la reserva no se empieza otra versión (la primera siempre
    // se procesa, así que cada ejecución avanza). Se confirma lo hecho y el resto sigue pendiente.
    if (through !== null && lease.now() - lease.startedAt >= budget) {
      return { director, messages, through, stoppedByBudget: true };
    }
    try {
      const result = await processItem(item, batch, director, batch.messageCount + messages.length, deps, lease);
      director = result.director;
      messages.push(...result.messages);
      through = item.version;
    } catch (error) {
      // Se confirma hasta la versión anterior; esta queda pendiente (y es la primera del próximo lote).
      return { director, messages, through, error };
    }
  }
  return { director, messages, through };
}

/** Una versión: decide (director), escribe y valida. Lanza si el escritor falla. */
async function processItem(
  item: QueueItem,
  batch: ClaimedBatch,
  director: DirectorState,
  messageCount: number,
  deps: ChatDeps,
  lease: LeaseClock,
): Promise<{ director: DirectorState; messages: QueuedMessage[] }> {
  const events = EventsSchema.safeParse(item.events);
  const state = GameStateSchema.safeParse(item.state);
  const defective = !events.success || !state.success || item.attempts > CHAT_LIMITS.maxAttempts;
  const stale = batch.latest - item.version > CHAT_LIMITS.staleVersions;

  let next = director;
  let utterances: Utterance[] = [];
  if (item.isVictory && defective) {
    // Victoria en modo mínimo: no se descarta nunca, aunque sus datos fallen o haya agotado intentos.
    const winner = victoryWinner(item);
    if (winner && messageCount < CHAT_LIMITS.maxMessagesPerGame) {
      utterances = [{ speaker: winner, kind: "victory_win", trigger: "victory", rival: null, replyTo: null, important: true }];
    }
    if (events.success) next = trackCaptures(next, item.version, events.data);
  } else if (defective) {
    // Versión defectuosa o que ya ha fallado demasiadas veces: se salta sin hablar.
    return { director, messages: [] };
  } else if (stale && !item.isVictory) {
    // Desfasada (recuperación con retraso): se observa (rachas) pero no se comenta.
    next = trackCaptures(next, item.version, events.data!);
  } else {
    const plan = planChat(
      { version: item.version, events: events.data!, state: state.data as GameState, messageCount, director: next },
      deps.random,
    );
    next = plan.director;
    utterances = plan.utterances;
  }

  const written = await writeUtterances(item.version, utterances, next, deps, lease, item.isVictory && defective);
  next = recordPublished(
    next,
    item.version,
    written.map(({ message, lineId }) => ({ speaker: message.character_id, text: message.text, lineId })),
  );
  return { director: next, messages: written.map((w) => w.message) };
}

/**
 * Texto de cada intervención de una versión (las réplicas sin su mensaje se descartan). Devuelve
 * el mensaje a guardar y, aparte, la frase del catálogo usada (solo para el director).
 */
async function writeUtterances(
  version: number,
  utterances: readonly Utterance[],
  director: DirectorState,
  deps: ChatDeps,
  lease: LeaseClock,
  minimal: boolean,
): Promise<{ message: QueuedMessage; lineId?: string }[]> {
  const recent: RecentText[] = [...director.recent];
  const messages: QueuedMessage[] = [];
  const results: { message: QueuedMessage; lineId?: string }[] = [];
  const seqOf = new Map<number, number>();
  for (const [index, utterance] of utterances.entries()) {
    if (utterance.replyTo !== null && !seqOf.has(utterance.replyTo)) continue;
    const replyToSeq = utterance.replyTo === null ? null : seqOf.get(utterance.replyTo)!;
    const request = {
      utterance,
      recent,
      replyToText: replyToSeq === null ? null : messages[replyToSeq].text,
      usedLines: director.usedLines[utterance.speaker] ?? [],
      usedCatchphrases: director.usedCatchphrases[utterance.speaker] ?? [],
    };
    let written = minimal ? await deps.fallbackWriter.write(request) : await writeWithFallback(request, deps, lease);
    let text = written ? validateChatText(written.text, recent) : null;
    // La victoria siempre tiene mensaje: si todas sus frases "se repiten", se ignora la antirrepetición
    // y se escribe con el escritor local (nunca depende del principal).
    if (!text && utterance.trigger === "victory" && utterance.replyTo === null) {
      written = await deps.fallbackWriter.write({ ...request, recent: [] });
      text = written ? validateChatText(written.text, []) : null;
    }
    if (!written || !text) continue;
    seqOf.set(index, messages.length);
    const message: QueuedMessage = {
      version,
      seq: messages.length,
      character_id: utterance.speaker,
      trigger: utterance.trigger,
      reply_to_seq: replyToSeq,
      text,
      source: written.source,
    };
    messages.push(message);
    results.push({ message, ...(written.lineId ? { lineId: written.lineId } : {}) });
    recent.push({ speaker: utterance.speaker, text });
  }
  return results;
}

/** Reserva sin límite (para llamar a `processBatch` fuera de `drainChat`, p. ej. en pruebas). */
const unlimitedLease = (): LeaseClock => ({ startedAt: 0, endsAt: Number.POSITIVE_INFINITY, now: () => 0 });

/**
 * Escribe con el escritor principal con un tiempo máximo ajustado a lo que queda de reserva (menos el
 * margen para confirmar). Si falla o agota el tiempo, o ya no queda tiempo, usa el escritor local.
 * Una llamada que agota el tiempo se aborta (`signal`) y su resultado tardío se ignora: no se repite.
 * Si el local también falla, el error se propaga (la versión queda pendiente, como antes).
 */
async function writeWithFallback(request: ChatWriteRequest, deps: ChatDeps, lease: LeaseClock): Promise<WrittenText | null> {
  if (deps.writer === deps.fallbackWriter) return deps.writer.write(request);
  const timeoutMs = Math.min(CHAT_LIMITS.writerTimeoutMs, lease.endsAt - CHAT_LIMITS.commitMarginMs - lease.now());
  if (timeoutMs < CHAT_LIMITS.minWriterMs) return deps.fallbackWriter.write(request);
  try {
    return await withTimeout((signal) => deps.writer.write({ ...request, signal, timeoutMs }), timeoutMs, deps);
  } catch {
    return deps.fallbackWriter.write(request);
  }
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, deps: ChatDeps): Promise<T> {
  const set = deps.setTimeout ?? ((fn: () => void, t: number) => setTimeout(fn, t));
  const clear = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = set(() => {
      controller.abort();
      reject(new ChatWriterTimeoutError(`El escritor superó ${Math.round(ms)} ms`));
    }, ms);
    let pending: Promise<T>;
    try {
      // Un escritor que lanza de forma síncrona (o no devuelve una promesa) también limpia el temporizador.
      pending = Promise.resolve(run(controller.signal));
    } catch (error) {
      clear(timer);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        clear(timer);
        resolve(value);
      },
      (error: unknown) => {
        clear(timer);
        reject(error);
      },
    );
  });
}

/** Ganador de una versión de victoria, leyendo los eventos sin validarlos del todo (modo mínimo). */
function victoryWinner(item: QueueItem): PlayerId | null {
  if (!Array.isArray(item.events)) return null;
  for (const raw of item.events as unknown[]) {
    const e = raw as Partial<GameEvent> & { place?: unknown; playerId?: unknown };
    if (e && e.type === "player_finished" && e.place === 1 && typeof e.playerId === "string" && CHAT_STORAGE.characterIdPattern.test(e.playerId)) {
      return e.playerId;
    }
  }
  return null;
}
