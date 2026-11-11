import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@/lib/engine";
import { GameResponseSchema } from "@/lib/game/api";
import { CHARACTER_IDS } from "@/lib/game/characters";
import type { StoredGame } from "@/lib/game/schemas";

vi.mock("server-only", () => ({}));

const get = vi.fn();
vi.mock("@/lib/game/repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/repository")>();
  return { ...original, getGamesRepository: () => ({ create: vi.fn(), get }) };
});

const { GET } = await import("../route");
const { GameRepositoryError } = await import("@/lib/game/repository");
const { SupabaseEnvError } = await import("@/lib/supabase/env");

const ID = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

const stored: StoredGame = {
  id: ID,
  state: createGame([...CHARACTER_IDS]),
  version: 1,
  engineVersion: 1,
  status: "playing",
  winner: null,
  lastAction: null,
  lastEvents: [],
  processingUntil: null,
  createdAt: "2026-11-10T20:18:45.185698+00:00",
  updatedAt: "2026-11-10T20:18:45.185698+00:00",
  finishedAt: null,
};

const call = (id: string) =>
  GET(new Request(`http://localhost/api/games/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/games/[id]", () => {
  beforeEach(() => {
    get.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("200 con el estado y la versión, sin caché y sin datos internos", async () => {
    get.mockResolvedValue(stored);
    const response = await call(ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(GameResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({ id: ID, version: 1, status: "playing", winner: null, lastAction: null, lastEvents: [] });
    expect(body.state).toEqual(stored.state);
    for (const key of ["lock_token", "lockToken", "processingUntil", "engineVersion"]) expect(body).not.toHaveProperty(key);
    expect(get).toHaveBeenCalledWith(ID);
  });

  it("incluye la última acción y sus eventos; y una partida terminada con su ganador", async () => {
    const action = { type: "roll" as const, playerId: "ai-pink", value: 3 };
    const events = [
      { type: "dice_rolled" as const, playerId: "ai-pink", value: 3 },
      { type: "no_moves" as const, playerId: "ai-pink", value: 3 },
      { type: "turn_changed" as const, playerId: "ai-blue" },
    ];
    get.mockResolvedValue({ ...stored, version: 2, lastAction: action, lastEvents: events });
    let body = await (await call(ID)).json();
    expect(body).toMatchObject({ version: 2, lastAction: action, lastEvents: events });

    const finishedState = { ...stored.state, status: "finished" as const, winner: "ai-green", ranking: ["ai-green", "ai-pink", "ai-purple", "ai-blue"] };
    get.mockResolvedValue({ ...stored, state: finishedState, status: "finished", winner: "ai-green", finishedAt: "2026-11-11T00:59:07+00:00" });
    body = await (await call(ID)).json();
    expect(GameResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ status: "finished", winner: "ai-green", finishedAt: "2026-11-11T00:59:07+00:00" });
  });

  it("404 si la partida no existe (o el id no es válido)", async () => {
    get.mockResolvedValue(null);
    for (const id of [ID, "no-es-un-uuid"]) {
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("not_found");
    }
  });

  it("503 genérico si falla la base de datos (sin el código de PostgreSQL)", async () => {
    get.mockRejectedValue(new GameRepositoryError("database", "Error de base de datos al leer la partida", "42501"));
    const response = await call(ID);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("storage_unavailable");
    expect(text).not.toContain("42501");
  });

  it("500 genérico si la partida guardada no es válida o la configuración es incorrecta", async () => {
    get.mockRejectedValue(new GameRepositoryError("invalid_data", "Partida guardada no válida: state.turn …"));
    let response = await call(ID);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("state.turn");

    get.mockRejectedValue(new SupabaseEnvError("SUPABASE_SECRET_KEY: falta"));
    response = await call(ID);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("server_misconfigured");
    expect(text).not.toContain("SUPABASE_SECRET_KEY");
  });
});
