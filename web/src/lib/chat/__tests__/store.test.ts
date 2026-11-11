import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ChatStoreError, createChatStore } = await import("../store");
const { initialDirectorState } = await import("../director");

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
type Result = { data: unknown; error: { code?: string; message: string } | null };

function fakeClient(result: Result) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gt", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => (calls.push({ method, args }), chain);
  }
  chain.then = (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    rpc: (name: string, args: unknown) => (calls.push({ method: `rpc:${name}`, args: [args] }), Promise.resolve(result)),
    from: (table: string) => (calls.push({ method: "from", args: [table] }), chain),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const dbRow = (id: number) => ({
  id, game_id: GAME, version: 7, seq: 0, character_id: "ai-blue", trigger: "goal", reply_to_seq: null,
  text: "¡Ficha en meta! ¡Gooool!", source: "local", created_at: "2026-11-11T10:00:00+00:00",
});

describe("ChatStore (Supabase)", () => {
  it("claim: llama a chat_claim con los parámetros exactos; filas → lote en orden, sin filas → null", async () => {
    const row = (version: number, extra = {}) => ({
      version, events: [], state: {}, is_victory: false, attempts: 1,
      last_version: 3, message_count: 4, director_state: { a: 1 }, through: 5, latest: 9, ...extra,
    });
    const ok = fakeClient({ data: [row(4), row(5, { is_victory: true })], error: null });
    expect(await createChatStore(ok.client).claim(GAME, "tok", 10, 25)).toEqual({
      items: [
        { version: 4, events: [], state: {}, isVictory: false, attempts: 1 },
        { version: 5, events: [], state: {}, isVictory: true, attempts: 1 },
      ],
      lastVersion: 3, through: 5, latest: 9, messageCount: 4, directorState: { a: 1 },
    });
    expect(ok.calls[0]).toEqual({ method: "rpc:chat_claim", args: [{ p_game_id: GAME, p_token: "tok", p_lease_seconds: 10, p_batch_size: 25 }] });
    const none = fakeClient({ data: [], error: null });
    expect(await createChatStore(none.client).claim(GAME, "tok", 10, 25)).toBeNull();
    const bad = fakeClient({ data: [{ version: "x" }], error: null });
    await expect(createChatStore(bad.client).claim(GAME, "tok", 10, 25)).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("commit: valida antes de enviar; fila → insertados y si quedan más; sin filas → reserva perdida", async () => {
    const message = { version: 7, seq: 0, character_id: "ai-pink", trigger: "capture" as const, reply_to_seq: null, text: "¡A casa!", source: "local" as const };
    const ok = fakeClient({ data: [{ inserted: 1, has_more: true }], error: null });
    expect(await createChatStore(ok.client).commit(GAME, "tok", 7, initialDirectorState(), [message], 60)).toEqual({ inserted: 1, hasMore: true });
    expect(ok.calls[0].args[0]).toMatchObject({ p_game_id: GAME, p_token: "tok", p_through: 7, p_messages: [message], p_max_messages: 60 });
    const lost = fakeClient({ data: [], error: null });
    expect(await createChatStore(lost.client).commit(GAME, "tok", 7, initialDirectorState(), [], 60)).toBeNull();

    const invalid = fakeClient({ data: [], error: null });
    await expect(
      createChatStore(invalid.client).commit(GAME, "tok", 7, initialDirectorState(), [{ ...message, text: "" }], 60),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    await expect(
      createChatStore(invalid.client).commit(GAME, "tok", 7, initialDirectorState(), [{ ...message, seq: 1, reply_to_seq: 1 }], 60),
    ).rejects.toBeInstanceOf(ChatStoreError);
    expect(invalid.calls).toEqual([]); // nada llegó a la BD
  });

  it("pending: consulta la cola de la partida", async () => {
    const yes = fakeClient({ data: [{ version: 12 }], error: null });
    expect(await createChatStore(yes.client).pending(GAME)).toBe(true);
    expect(yes.calls.map((c) => c.method)).toEqual(["from", "select", "eq", "limit"]);
    expect(yes.calls[0].args).toEqual(["game_chat_queue"]);
    const no = fakeClient({ data: [], error: null });
    expect(await createChatStore(no.client).pending(GAME)).toBe(false);
  });

  it("latest y after: filtros y orden; filas no válidas → invalid_data", async () => {
    const latest = fakeClient({ data: [dbRow(9), dbRow(8)], error: null });
    expect((await createChatStore(latest.client).latest(GAME, 20)).map((m) => m.id)).toEqual([8, 9]);
    expect(latest.calls.map((c) => c.method)).toEqual(["from", "select", "eq", "order", "limit"]);
    expect(latest.calls[3].args).toEqual(["id", { ascending: false }]);

    const after = fakeClient({ data: [dbRow(10)], error: null });
    await createChatStore(after.client).after(GAME, 9, 100);
    expect(after.calls.find((c) => c.method === "gt")!.args).toEqual(["id", 9]);
    expect(after.calls.find((c) => c.method === "order")!.args).toEqual(["id", { ascending: true }]);

    const bad = fakeClient({ data: [{ ...dbRow(1), text: "" }], error: null });
    await expect(createChatStore(bad.client).latest(GAME, 20)).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("errores: código de PostgreSQL solo para el registro, sin el mensaje original", async () => {
    const failing = fakeClient({ data: null, error: { code: "42P01", message: 'relation "public.game_chat" does not exist' } });
    const error = await createChatStore(failing.client).claim(GAME, "t", 10, 25).catch((e) => e);
    expect(error).toMatchObject({ kind: "database", code: "42P01" });
    expect(error.message).not.toContain("relation");
    const network = fakeClient({ data: null, error: { message: "fetch failed" } });
    expect(await createChatStore(network.client).release(GAME, "t").catch((e) => e)).toMatchObject({ kind: "database", code: undefined });
  });
});
