// Única fuente de verdad: los límites de config.ts coinciden con las restricciones del SQL y los
// esquemas los usan (en vez de repetir números).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_LIMITS, CHAT_STORAGE } from "../config";
import { CHAT_SOURCES, CHAT_TRIGGERS, ChatMessageSchema, DirectorStateSchema, NewChatMessageSchema } from "../schemas";

const SQL = readFileSync(new URL("../../../../supabase/8.2a-chat.sql", import.meta.url), "utf8");

describe("config.ts ↔ supabase/8.2a-chat.sql", () => {
  it("los disparadores y orígenes son los mismos que admite la tabla", () => {
    const triggers = SQL.match(/trigger\s+text not null check \(trigger in \(([^)]*)\)\)/)![1];
    expect([...triggers.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...CHAT_TRIGGERS]);
    const sources = SQL.match(/source\s+text not null default 'local' check \(source in \(([^)]*)\)\)/)![1];
    expect([...sources.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...CHAT_SOURCES]);
  });

  it("longitud del texto, seq y formato del personaje coinciden con las restricciones", () => {
    expect(SQL).toContain(`check (char_length(text) between 1 and ${CHAT_STORAGE.maxStoredTextLength})`);
    expect(SQL).toContain(`check (seq between 0 and ${CHAT_STORAGE.maxSeq})`);
    expect(SQL).toContain(`check (character_id ~ '${CHAT_STORAGE.characterIdPattern.source}')`);
    // Lo que publica el chat cabe siempre en la tabla.
    expect(CHAT_LIMITS.maxTextLength).toBeLessThanOrEqual(CHAT_STORAGE.maxStoredTextLength);
  });

  it("la reserva y el lote están dentro de los rangos que acepta chat_claim", () => {
    expect(SQL).toContain("p_lease_seconds < 1 or p_lease_seconds > 60");
    expect(SQL).toContain("p_batch_size < 1 or p_batch_size > 200");
    expect(CHAT_LIMITS.leaseSeconds).toBeGreaterThanOrEqual(1);
    expect(CHAT_LIMITS.leaseSeconds).toBeLessThanOrEqual(60);
    expect(CHAT_LIMITS.batchSize).toBeGreaterThanOrEqual(1);
    expect(CHAT_LIMITS.batchSize).toBeLessThanOrEqual(200);
    expect(SQL).toContain("message_count between 0 and 1000");
    expect(CHAT_LIMITS.maxMessagesPerGame).toBeLessThanOrEqual(1000);
  });
});

describe("los esquemas usan los límites de config.ts", () => {
  const message = { id: 1, version: 2, seq: 0, characterId: "ai-pink", trigger: "goal", replyToSeq: null, text: "x", createdAt: "" };

  it("texto y seq del contrato público", () => {
    expect(ChatMessageSchema.safeParse({ ...message, text: "x".repeat(CHAT_STORAGE.maxStoredTextLength) }).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ ...message, text: "x".repeat(CHAT_STORAGE.maxStoredTextLength + 1) }).success).toBe(false);
    expect(ChatMessageSchema.safeParse({ ...message, seq: CHAT_STORAGE.maxSeq }).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ ...message, seq: CHAT_STORAGE.maxSeq + 1 }).success).toBe(false);
    expect(ChatMessageSchema.safeParse({ ...message, characterId: "Pepe" }).success).toBe(false);
  });

  it("un mensaje nuevo no supera la longitud que publica el chat", () => {
    const fresh = { version: 2, seq: 0, character_id: "ai-pink", trigger: "goal", reply_to_seq: null, source: "local" };
    expect(NewChatMessageSchema.safeParse({ ...fresh, text: "x".repeat(CHAT_LIMITS.maxTextLength) }).success).toBe(true);
    expect(NewChatMessageSchema.safeParse({ ...fresh, text: "x".repeat(CHAT_LIMITS.maxTextLength + 1) }).success).toBe(false);
  });

  it("el estado del director admite exactamente lo que el director guarda", () => {
    const base = { lastMessageVersion: null, lastSpokeAt: {}, captures: [], recent: [], usedLines: {} };
    const recent = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: "ai-pink", text: `t${i}` }));
    const captures = (n: number) => Array.from({ length: n }, (_, i) => ({ v: i + 1, by: "ai-pink", victim: "ai-blue" }));
    const used = (n: number) => ({ "ai-pink": Array.from({ length: n }, (_, i) => `goal:${i}`) });
    expect(DirectorStateSchema.safeParse({ ...base, recent: recent(CHAT_LIMITS.recentTexts) }).success).toBe(true);
    expect(DirectorStateSchema.safeParse({ ...base, recent: recent(CHAT_LIMITS.recentTexts + 1) }).success).toBe(false);
    expect(DirectorStateSchema.safeParse({ ...base, captures: captures(CHAT_LIMITS.maxTrackedCaptures) }).success).toBe(true);
    expect(DirectorStateSchema.safeParse({ ...base, captures: captures(CHAT_LIMITS.maxTrackedCaptures + 1) }).success).toBe(false);
    expect(DirectorStateSchema.safeParse({ ...base, usedLines: used(CHAT_LIMITS.usedLinesPerCharacter) }).success).toBe(true);
    expect(DirectorStateSchema.safeParse({ ...base, usedLines: used(CHAT_LIMITS.usedLinesPerCharacter + 1) }).success).toBe(false);
    // Un estado guardado antes de `usedLines` sigue siendo válido (se lee como vacío).
    const legacy = { lastMessageVersion: null, lastSpokeAt: {}, captures: [], recent: [] };
    expect(DirectorStateSchema.parse(legacy).usedLines).toEqual({});
  });
});
