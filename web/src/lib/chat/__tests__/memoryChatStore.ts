// ChatStore en memoria para las pruebas. Reproduce la semántica de supabase/8.2a-chat.sql:
// - `enqueue` hace lo que el trigger `games_chat_enqueue` (idempotente por partida+versión,
//   `is_victory` si hay un player_finished con puesto 1). Las pruebas lo llaman a la vez que
//   "confirman" la versión, como la transacción del avance.
// - chat_claim: reserva el siguiente lote (versiones > cursor, en orden, hasta batchSize) si no hay
//   reserva vigente (las caducadas se pueden volver a tomar); suma 1 a `attempts` de la primera.
// - chat_commit: solo con el mismo token, `through` dentro del lote y la reserva sin caducar; inserta sin
//   duplicar, borra el lote de la cola, avanza el cursor, guarda el estado y libera. Si no, null.
//   Mensajes fuera del lote o por encima del máximo → error sin cambios.
// - Reloj controlable (`advance`), fallos inyectables antes de aplicar (`fail`) y respuestas
//   perdidas: la operación se aplica pero la llamada falla (`loseResponse`).

import type { ChatStore, ClaimedBatch } from "../store";
import type { ChatMessage, ChatMessageRow, DirectorState, NewChatMessage } from "../schemas";
import { toChatMessage } from "../schemas";

interface ChatRow {
  lastVersion: number;
  messageCount: number;
  directorState: unknown;
  lockToken: string | null;
  lockedUntil: number | null;
  lockedThrough: number | null;
}

interface QueueRow {
  gameId: string;
  version: number;
  events: unknown;
  state: unknown;
  isVictory: boolean;
  attempts: number;
}

type Op = "claim" | "commit" | "release" | "pending" | "latest" | "after";

export function createMemoryChatStore() {
  let now = 0;
  let nextId = 1;
  const chats = new Map<string, ChatRow>();
  const queue: QueueRow[] = [];
  const rows: ChatMessageRow[] = [];
  const failures = new Map<Op, number>();
  const lost = new Map<Op, number>();
  const calls: Op[] = [];
  const listeners = new Set<(row: ChatMessageRow) => void>();

  const take = (map: Map<Op, number>, op: Op) => {
    const n = map.get(op) ?? 0;
    if (n > 0) map.set(op, n - 1);
    return n > 0;
  };
  const before = async (op: Op) => {
    calls.push(op);
    await Promise.resolve();
    if (take(failures, op)) throw Object.assign(new Error(`fallo simulado en ${op}`), { name: "SimulatedError" });
  };
  const after = async <T>(op: Op, value: T): Promise<T> => {
    await Promise.resolve();
    if (take(lost, op)) throw Object.assign(new Error(`respuesta perdida en ${op}`), { name: "SimulatedError" });
    return value;
  };
  const chatOf = (gameId: string) => {
    const row = chats.get(gameId) ?? { lastVersion: 0, messageCount: 0, directorState: {}, lockToken: null, lockedUntil: null, lockedThrough: null };
    chats.set(gameId, row);
    return row;
  };
  const pendingOf = (gameId: string, cursor: number) =>
    queue.filter((q) => q.gameId === gameId && q.version > cursor).sort((a, b) => a.version - b.version);

  const store: ChatStore = {
    async claim(gameId, token, leaseSeconds, batchSize) {
      await before("claim");
      const chat = chatOf(gameId);
      const free = chat.lockToken === null || (chat.lockedUntil !== null && chat.lockedUntil < now);
      const pending = pendingOf(gameId, chat.lastVersion);
      if (!free || pending.length === 0) return after("claim", null);
      const batch = pending.slice(0, batchSize);
      chat.lockToken = token;
      chat.lockedUntil = now + leaseSeconds * 1000;
      chat.lockedThrough = batch[batch.length - 1].version;
      batch[0].attempts++; // solo la primera del lote
      const result: ClaimedBatch = {
        items: batch.map((q) => ({ version: q.version, events: structuredClone(q.events), state: structuredClone(q.state), isVictory: q.isVictory, attempts: q.attempts })),
        lastVersion: chat.lastVersion,
        through: chat.lockedThrough,
        latest: Math.max(...queue.filter((q) => q.gameId === gameId).map((q) => q.version)),
        messageCount: chat.messageCount,
        directorState: structuredClone(chat.directorState),
      };
      return after("claim", result);
    },

    async commit(gameId, token, through, director: DirectorState, messages: readonly NewChatMessage[], maxMessages) {
      await before("commit");
      const chat = chats.get(gameId);
      if (
        !chat || chat.lockToken !== token || chat.lockedThrough === null || through <= chat.lastVersion ||
        through > chat.lockedThrough || chat.lockedUntil === null || chat.lockedUntil < now
      ) {
        return after("commit", null);
      }
      if (chat.messageCount + messages.length > maxMessages) throw new Error("límite de mensajes superado");
      if (messages.some((m) => m.version <= chat.lastVersion || m.version > through)) throw new Error("mensaje fuera del lote reservado");
      let inserted = 0;
      for (const m of [...messages].sort((a, b) => a.version - b.version || a.seq - b.seq)) {
        if (rows.some((r) => r.game_id === gameId && r.version === m.version && r.seq === m.seq)) continue;
        const stored: ChatMessageRow = {
          id: nextId++,
          game_id: gameId,
          version: m.version,
          seq: m.seq,
          character_id: m.character_id,
          trigger: m.trigger,
          reply_to_seq: m.reply_to_seq,
          text: m.text,
          source: m.source,
          created_at: new Date(Date.UTC(2026, 10, 11) + now).toISOString(),
        };
        rows.push(stored);
        inserted++;
        for (const listener of listeners) listener(structuredClone(stored));
      }
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].gameId === gameId && queue[i].version <= through) queue.splice(i, 1);
      }
      chat.lastVersion = through;
      chat.messageCount += inserted;
      chat.directorState = structuredClone(director);
      chat.lockToken = null;
      chat.lockedUntil = null;
      chat.lockedThrough = null;
      return after("commit", { inserted, hasMore: queue.some((q) => q.gameId === gameId) });
    },

    async release(gameId, token) {
      await before("release");
      const chat = chats.get(gameId);
      if (chat && chat.lockToken === token) {
        chat.lockToken = null;
        chat.lockedUntil = null;
        chat.lockedThrough = null;
      }
      return after("release", undefined);
    },

    async pending(gameId) {
      await before("pending");
      return after("pending", queue.some((q) => q.gameId === gameId));
    },

    async latest(gameId, limit): Promise<ChatMessage[]> {
      await before("latest");
      return after("latest", rows.filter((r) => r.game_id === gameId).slice(-limit).map(toChatMessage));
    },

    async after(gameId, afterId, limit): Promise<ChatMessage[]> {
      await before("after");
      return after("after", rows.filter((r) => r.game_id === gameId && r.id > afterId).slice(0, limit).map(toChatMessage));
    },
  };

  return {
    store,
    rows,
    chats,
    queue,
    calls,
    /** Lo que hace el trigger de `games` al confirmar una versión (idempotente). */
    enqueue(gameId: string, version: number, events: unknown, state: unknown) {
      if (queue.some((q) => q.gameId === gameId && q.version === version)) return;
      const isVictory =
        Array.isArray(events) && events.some((e) => e && (e as { type?: unknown }).type === "player_finished" && (e as { place?: unknown }).place === 1);
      queue.push({ gameId, version, events: structuredClone(events), state: structuredClone(state), isVictory, attempts: 0 });
    },
    /** Avanza el reloj de la "BD" (ms). */
    advance: (ms: number) => (now += ms),
    /** Las próximas `times` llamadas a `op` fallan ANTES de aplicarse. */
    fail: (op: Op, times = 1) => failures.set(op, times),
    /** Las próximas `times` llamadas a `op` se aplican pero la respuesta se pierde. */
    loseResponse: (op: Op, times = 1) => lost.set(op, times),
    /** Difusión de inserciones (como Realtime). */
    onInsert: (listener: (row: ChatMessageRow) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Inserta un mensaje directamente (para preparar pruebas del navegador). */
    insertRow: (row: Omit<ChatMessageRow, "id">) => {
      const stored = { ...row, id: nextId++ };
      rows.push(stored);
      for (const listener of listeners) listener(structuredClone(stored));
      return stored;
    },
  };
}
