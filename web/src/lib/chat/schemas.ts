// Contratos del chat (sin dependencias de servidor: los usan el navegador y el servidor).

import { z } from "zod";
import { CHAT_LIMITS, CHAT_STORAGE } from "./config";

export const CHAT_TRIGGERS = [
  "victory",
  "capture",
  "capture_streak",
  "bad_streak",
  "third_six",
  "finish_place",
  "goal",
  "ambient",
] as const;
export type ChatTrigger = (typeof CHAT_TRIGGERS)[number];

/** Origen del texto: frase local o (fase 8.2b) un LLM. */
export const CHAT_SOURCES = ["local", "llm"] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];

const CharacterIdSchema = z.string().regex(CHAT_STORAGE.characterIdPattern);
const TextSchema = z.string().min(1).max(CHAT_STORAGE.maxStoredTextLength);
const SeqSchema = z.number().int().min(0).max(CHAT_STORAGE.maxSeq);

/** Mensaje tal como se expone (API, carga inicial y Realtime). */
export const ChatMessageSchema = z.object({
  id: z.number().int().positive(),
  /** Versión de la partida cuyo acontecimiento lo originó. */
  version: z.number().int().min(1),
  /** Orden dentro de la versión (0 = mensaje, 1 = réplica). */
  seq: SeqSchema,
  characterId: CharacterIdSchema,
  trigger: z.enum(CHAT_TRIGGERS),
  /** `seq` del mensaje al que responde (misma versión), o `null`. */
  replyToSeq: SeqSchema.nullable(),
  text: TextSchema,
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Fila de `public.game_messages` (PostgREST o Realtime). */
export const ChatMessageRowSchema = z.object({
  id: z.number().int().positive(),
  game_id: z.uuid(),
  version: z.number().int().min(1),
  seq: SeqSchema,
  character_id: CharacterIdSchema,
  trigger: z.enum(CHAT_TRIGGERS),
  reply_to_seq: SeqSchema.nullable(),
  text: TextSchema,
  source: z.enum(CHAT_SOURCES),
  created_at: z.string(),
});
export type ChatMessageRow = z.infer<typeof ChatMessageRowSchema>;

export const toChatMessage = (row: ChatMessageRow): ChatMessage => ({
  id: row.id,
  version: row.version,
  seq: row.seq,
  characterId: row.character_id,
  trigger: row.trigger,
  replyToSeq: row.reply_to_seq,
  text: row.text,
  createdAt: row.created_at,
});

/** Respuesta de GET /api/games/[id]/messages. */
export const ChatPageSchema = z.object({
  messages: z.array(ChatMessageSchema),
  /** Hay más mensajes después del último devuelto. */
  hasMore: z.boolean(),
  /** Quedan versiones de la partida pendientes de procesar por el chat (el servidor ya las ha puesto en marcha). */
  pending: z.boolean(),
});
export type ChatPage = z.infer<typeof ChatPageSchema>;

/** Mensaje nuevo a guardar (lo valida el servidor antes de enviarlo a PostgreSQL). */
export const NewChatMessageSchema = z
  .object({
    /** Versión del lote a la que pertenece. */
    version: z.number().int().min(1),
    seq: SeqSchema,
    character_id: CharacterIdSchema,
    trigger: z.enum(CHAT_TRIGGERS),
    reply_to_seq: SeqSchema.nullable(),
    text: z.string().min(1).max(CHAT_LIMITS.maxTextLength),
    source: z.enum(CHAT_SOURCES),
  })
  .refine((m) => m.reply_to_seq === null || m.reply_to_seq < m.seq, { error: "reply_to_seq debe ser anterior" });
export type NewChatMessage = z.infer<typeof NewChatMessageSchema>;

/** Estado del director que se guarda en `game_chat.director_state`. */
export const DirectorStateSchema = z.object({
  /** Versión del último mensaje publicado. */
  lastMessageVersion: z.number().int().min(1).nullable(),
  /** Versión del último mensaje de cada personaje. */
  lastSpokeAt: z.record(z.string(), z.number().int().min(1)),
  /** Capturas recientes (para las rachas). */
  captures: z
    .array(z.object({ v: z.number().int().min(1), by: z.string(), victim: z.string() }))
    .max(CHAT_LIMITS.maxTrackedCaptures),
  /** Últimos textos publicados (para no repetirse). */
  recent: z.array(z.object({ speaker: z.string(), text: z.string() })).max(CHAT_LIMITS.recentTexts),
  /**
   * Frases ya usadas por cada personaje (identificador `tipo:índice`, de la más antigua a la más
   * reciente). Un estado guardado sin este campo (anterior a él) se lee como vacío.
   */
  usedLines: z
    .record(z.string(), z.array(z.string()).max(CHAT_LIMITS.usedLinesPerCharacter))
    .default({}),
  /**
   * Coletillas que cada personaje ya ha publicado en la partida (índices de `character.catchphrases`,
   * sin repetir), de mensajes del LLM o locales. Un estado guardado sin este campo se lee como vacío.
   */
  usedCatchphrases: z
    .record(z.string(), z.array(z.number().int().min(0)).max(CHAT_LIMITS.usedCatchphrasesPerCharacter))
    .default({}),
  /**
   * Continuidad del historial de capturas (ver `trackCaptures` en director.ts). Última versión observada
   * por el director (nunca retrocede). Un estado guardado sin este campo se lee como `null`: si la
   * siguiente versión no es la primera de la cola (v2), el historial se marca incompleto.
   */
  observedThrough: z.number().int().min(1).nullable().default(null),
  /**
   * Última versión NO observada (hueco, anomalía o captura descartada por el límite), o `null` si no ha
   * habido ninguna. Nunca retrocede. El historial es completo cuando ya no puede afectar a la ventana.
   */
  historyGapThrough: z.number().int().min(1).nullable().default(null),
});
export type DirectorState = z.infer<typeof DirectorStateSchema>;
