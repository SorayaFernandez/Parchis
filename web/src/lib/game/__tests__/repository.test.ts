import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createGame, type GameState } from "@/lib/engine";

// `server-only` impide importar el repositorio fuera del servidor; en las pruebas se neutraliza.
vi.mock("server-only", () => ({}));

const { GameRepositoryError, createGamesRepository, parseGameRow } = await import("../repository");
const { CHARACTER_IDS } = await import("../characters");

const ID = "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f";

function rowFor(state: GameState, extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    state: JSON.parse(JSON.stringify(state)),
    engine_version: 1,
    status: state.status,
    winner: state.winner,
    version: 1,
    lock_token: null,
    processing_until: null,
    last_action: null,
    last_events: [],
    created_at: "2026-11-10T20:00:00+00:00",
    updated_at: "2026-11-10T20:00:00+00:00",
    finished_at: null,
    ...extra,
  };
}

type Result = { data: unknown; error: { code: string; message: string } | null };

/** Cliente falso con la forma mínima de las llamadas que hace el repositorio. */
function fakeClient(result: Result) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain = {
    update: (...args: unknown[]) => (calls.push({ method: "update", args }), chain),
    then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve), // await sin select()
    insert: (...args: unknown[]) => (calls.push({ method: "insert", args }), chain),
    select: (...args: unknown[]) => (calls.push({ method: "select", args }), chain),
    eq: (...args: unknown[]) => (calls.push({ method: "eq", args }), chain),
    single: async () => result,
    maybeSingle: async () => result,
  };
  const client = { from: (table: string) => (calls.push({ method: "from", args: [table] }), chain) };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("repositorio de partidas", () => {
  const state = createGame([...CHARACTER_IDS]);

  it("create: inserta el estado con engine_version y devuelve la partida validada", async () => {
    const { client, calls } = fakeClient({ data: rowFor(state), error: null });
    const game = await createGamesRepository(client).create(state);
    expect(calls[0]).toEqual({ method: "from", args: ["games"] });
    expect(calls[1]).toEqual({ method: "insert", args: [{ state, engine_version: 1 }] });
    expect(game).toMatchObject({ id: ID, version: 1, status: "playing" });
    expect(game.state).toEqual(state);
  });

  it("create: no escribe un estado inválido", async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    const broken = { ...state, turn: "nadie" };
    await expect(createGamesRepository(client).create(broken)).rejects.toMatchObject({ kind: "invalid_data" });
    expect(calls).toHaveLength(0);
  });

  it("create: traduce el error de Supabase sin exponer su mensaje", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501", message: "permission denied for table games" } });
    const error = await createGamesRepository(client).create(state).catch((e) => e);
    expect(error).toBeInstanceOf(GameRepositoryError);
    expect(error).toMatchObject({ kind: "database", code: "42501" });
    expect(error.message).not.toContain("permission denied");
  });

  it("get: devuelve la partida, null si no existe y null sin consultar si el id no es UUID", async () => {
    expect(await createGamesRepository(fakeClient({ data: rowFor(state), error: null }).client).get(ID)).toMatchObject({ id: ID });
    expect(await createGamesRepository(fakeClient({ data: null, error: null }).client).get(ID)).toBeNull();
    const { client, calls } = fakeClient({ data: rowFor(state), error: null });
    expect(await createGamesRepository(client).get("no-es-uuid")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("fallo de red (sin código de PostgreSQL): error 'database' que lo indica, sin código", async () => {
    const { client } = fakeClient({ data: null, error: { code: "", message: "TypeError: fetch failed" } });
    const error = await createGamesRepository(client).get(ID).catch((e) => e);
    expect(error).toMatchObject({ kind: "database", code: undefined });
    expect(error.message).toBe("Fallo de red al leer la partida: TypeError: fetch failed");
  });

  it("claim: UPDATE lock_token filtrando id, versión y partida en juego; 55P03 o 0 filas → null", async () => {
    const ok = fakeClient({ data: rowFor(state), error: null });
    expect(await createGamesRepository(ok.client).claim(ID, 4, "tok")).toMatchObject({ id: ID });
    expect(ok.calls.slice(1)).toEqual([
      { method: "update", args: [{ lock_token: "tok" }] }, // sin processing_until: lo fija la BD
      { method: "eq", args: ["id", ID] },
      { method: "eq", args: ["version", 4] },
      { method: "eq", args: ["status", "playing"] },
      { method: "select", args: [] },
    ]);
    const busy = fakeClient({ data: null, error: { code: "55P03", message: "games: el turno ya está reservado" } });
    expect(await createGamesRepository(busy.client).claim(ID, 4, "tok")).toBeNull();
    expect(await createGamesRepository(fakeClient({ data: null, error: null }).client).claim(ID, 4, "tok")).toBeNull();
  });

  it("commit: versión + 1 con el mismo token en SET y WHERE; 55P03 o 0 filas → null", async () => {
    const action = { type: "roll" as const, playerId: "ai-pink", value: 3 };
    const events = [{ type: "dice_rolled" as const, playerId: "ai-pink", value: 3 }];
    const ok = fakeClient({ data: rowFor(state, { version: 5 }), error: null });
    expect(await createGamesRepository(ok.client).commit(ID, 4, "tok", { state, action, events })).toMatchObject({ version: 5 });
    expect(ok.calls.slice(1)).toEqual([
      { method: "update", args: [{ state, version: 5, last_action: action, last_events: events, lock_token: "tok" }] },
      { method: "eq", args: ["id", ID] },
      { method: "eq", args: ["version", 4] },
      { method: "eq", args: ["lock_token", "tok"] },
      { method: "select", args: [] },
    ]);
    const expired = fakeClient({ data: null, error: { code: "55P03", message: "games: no hay reserva vigente" } });
    expect(await createGamesRepository(expired.client).commit(ID, 4, "tok", { state, action, events })).toBeNull();
  });

  it("commit: no escribe un resultado inválido", async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    const bad = { state, action: { type: "roll" as const, playerId: "ai-pink", value: 9 }, events: [] };
    await expect(createGamesRepository(client).commit(ID, 4, "tok", bad)).rejects.toMatchObject({ kind: "invalid_data" });
    expect(calls).toHaveLength(0);
  });

  it("release: lock_token = null solo si la reserva sigue siendo del token", async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    await createGamesRepository(client).release(ID, "tok");
    expect(calls.slice(1)).toEqual([
      { method: "update", args: [{ lock_token: null }] },
      { method: "eq", args: ["id", ID] },
      { method: "eq", args: ["lock_token", "tok"] },
    ]);
  });

  it("parseGameRow: rechaza filas corruptas y formatos de estado no soportados", () => {
    expect(() => parseGameRow(rowFor(state, { state: { status: "playing" } }))).toThrow(GameRepositoryError);
    expect(() => parseGameRow(rowFor(state, { engine_version: 2 }))).toThrow(
      expect.objectContaining({ kind: "unsupported_version" }),
    );
  });
});
