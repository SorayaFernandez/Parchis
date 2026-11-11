// Persistencia del chat: `public.game_messages` y `public.game_chat` (ver supabase/chat.sql).
// La reserva y la confirmación son funciones de PostgreSQL (`chat_claim`, `chat_commit`,
// `chat_release`): atómicas en la BD, con el reloj de PostgreSQL. Solo el cliente de servidor.

import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ChatMessageRowSchema,
  NewChatMessageSchema,
  toChatMessage,
  type ChatMessage,
  type DirectorState,
  type NewChatMessage,
} from "./schemas";

export class ChatStoreError extends Error {
  override name = "ChatStoreError";
  constructor(
    readonly kind: "database" | "invalid_data",
    message: string,
    /** Código de PostgreSQL/PostgREST, si lo hay. Solo para registros. */
    readonly code?: string,
  ) {
    super(message);
  }
}

function databaseError(action: string, error: PostgrestError): ChatStoreError {
  if (!error.code) return new ChatStoreError("database", `Fallo de red al ${action}`);
  return new ChatStoreError("database", `Error de base de datos al ${action}`, error.code);
}

/** Una versión pendiente de la cola (datos sin validar: el servicio los valida). */
export interface QueueItem {
  version: number;
  events: unknown;
  state: unknown;
  isVictory: boolean;
  /** Veces que se ha reservado, contando esta. */
  attempts: number;
}

/** Lote reservado: versiones (lastVersion, through] en orden, y el estado del chat. */
export interface ClaimedBatch {
  items: QueueItem[];
  lastVersion: number;
  /** Última versión del lote (identifica el lote junto con el token). */
  through: number;
  /** Última versión pendiente en la cola (para detectar versiones desfasadas). */
  latest: number;
  messageCount: number;
  /** Sin validar: el servicio lo valida y, si no es válido, empieza de cero. */
  directorState: unknown;
}

/** Mensaje a guardar con su versión. */
export type QueuedMessage = NewChatMessage;

export interface ChatStore {
  /**
   * Reserva el siguiente lote de versiones pendientes (en orden, hasta `batchSize`) durante
   * `leaseSeconds` (reloj de la BD). `null` si no hay pendientes o hay otra reserva vigente.
   */
  claim(gameId: string, token: string, leaseSeconds: number, batchSize: number): Promise<ClaimedBatch | null>;
  /**
   * Confirma el lote reservado con `token` hasta la versión `through` (el final del lote, o antes si
   * el procesador se detuvo en una versión que falló): guarda mensajes y estado, avanza el cursor,
   * borra esas versiones de la cola y libera, en una transacción. `null` si la reserva ya no es
   * válida (no se guarda nada). `hasMore`: quedan versiones pendientes.
   */
  commit(
    gameId: string,
    token: string,
    through: number,
    director: DirectorState,
    messages: readonly QueuedMessage[],
    maxMessages: number,
  ): Promise<{ inserted: number; hasMore: boolean } | null>;
  /** Libera la reserva si sigue siendo de `token` (el lote sigue pendiente). */
  release(gameId: string, token: string): Promise<void>;
  /** Hay versiones pendientes de procesar. */
  pending(gameId: string): Promise<boolean>;
  /** Últimos `limit` mensajes, en orden. */
  latest(gameId: string, limit: number): Promise<ChatMessage[]>;
  /** Mensajes con id mayor que `afterId`, en orden, como mucho `limit`. */
  after(gameId: string, afterId: number, limit: number): Promise<ChatMessage[]>;
}

const ClaimRowSchema = z.object({
  version: z.number().int(),
  events: z.unknown(),
  state: z.unknown(),
  is_victory: z.boolean(),
  attempts: z.number().int(),
  last_version: z.number().int(),
  message_count: z.number().int(),
  director_state: z.unknown(),
  through: z.number().int(),
  latest: z.number().int(),
});

const CommitRowSchema = z.object({ inserted: z.number().int().min(0), has_more: z.boolean() });

function parseMessages(data: unknown): ChatMessage[] {
  const parsed = z.array(ChatMessageRowSchema).safeParse(data);
  if (!parsed.success) throw new ChatStoreError("invalid_data", "Mensajes guardados no válidos");
  return parsed.data.map(toChatMessage);
}

const COLUMNS = "id, game_id, version, seq, character_id, trigger, reply_to_seq, text, source, created_at";

export function createChatStore(client: SupabaseClient): ChatStore {
  return {
    async claim(gameId, token, leaseSeconds, batchSize) {
      const { data, error } = await client.rpc("chat_claim", {
        p_game_id: gameId,
        p_token: token,
        p_lease_seconds: leaseSeconds,
        p_batch_size: batchSize,
      });
      if (error) throw databaseError("reservar el chat", error);
      const rows = z.array(ClaimRowSchema).safeParse(data);
      if (!rows.success) throw new ChatStoreError("invalid_data", "Respuesta de reserva no válida");
      if (rows.data.length === 0) return null;
      const first = rows.data[0];
      return {
        items: rows.data.map((r) => ({ version: r.version, events: r.events, state: r.state, isVictory: r.is_victory, attempts: r.attempts })),
        lastVersion: first.last_version,
        through: first.through,
        latest: first.latest,
        messageCount: first.message_count,
        directorState: first.director_state,
      };
    },

    async commit(gameId, token, through, director, messages, maxMessages) {
      const checked = z.array(NewChatMessageSchema).safeParse(messages);
      if (!checked.success) throw new ChatStoreError("invalid_data", "Mensajes a guardar no válidos");
      const { data, error } = await client.rpc("chat_commit", {
        p_game_id: gameId,
        p_token: token,
        p_through: through,
        p_state: director,
        p_messages: checked.data,
        p_max_messages: maxMessages,
      });
      if (error) throw databaseError("guardar el chat", error);
      const rows = z.array(CommitRowSchema).safeParse(data);
      if (!rows.success) throw new ChatStoreError("invalid_data", "Respuesta de confirmación no válida");
      const row = rows.data[0];
      return row ? { inserted: row.inserted, hasMore: row.has_more } : null;
    },

    async release(gameId, token) {
      const { error } = await client.rpc("chat_release", { p_game_id: gameId, p_token: token });
      if (error) throw databaseError("liberar el chat", error);
    },

    async pending(gameId) {
      const { data, error } = await client.from("game_chat_queue").select("version").eq("game_id", gameId).limit(1);
      if (error) throw databaseError("consultar la cola del chat", error);
      return Array.isArray(data) && data.length > 0;
    },

    async latest(gameId, limit) {
      const { data, error } = await client
        .from("game_messages")
        .select(COLUMNS)
        .eq("game_id", gameId)
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw databaseError("leer el chat", error);
      return parseMessages(data).reverse();
    },

    async after(gameId, afterId, limit) {
      const { data, error } = await client
        .from("game_messages")
        .select(COLUMNS)
        .eq("game_id", gameId)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw databaseError("leer el chat", error);
      return parseMessages(data);
    },
  };
}

let store: ChatStore | null = null;

export function getChatStore(): ChatStore {
  store ??= createChatStore(getServerSupabase());
  return store;
}
