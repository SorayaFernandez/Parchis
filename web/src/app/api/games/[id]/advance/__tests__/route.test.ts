import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGame, type GameEvent } from "@/lib/engine";
import { CHARACTER_IDS } from "@/lib/game/characters";
import type { AdvanceDeps, AdvanceResult } from "@/lib/game/advance";

vi.mock("server-only", () => ({}));

// Se sustituye el servicio: aquí se prueba solo el endpoint (validación, códigos HTTP y dependencias).
const advanceGame = vi.fn<(id: string, version: number, deps: AdvanceDeps) => Promise<AdvanceResult>>();
vi.mock("@/lib/game/advance", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/advance")>();
  return { ...original, advanceGame: (...args: Parameters<typeof advanceGame>) => advanceGame(...args) };
});
vi.mock("@/lib/game/repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/repository")>();
  return { ...original, getGamesRepository: () => ({}) };
});

// El procesador del chat se programa para después de la respuesta: aquí solo se comprueba que se programa.
const scheduleDrain = vi.fn();
vi.mock("@/lib/chat/schedule", () => ({ scheduleDrain: (...args: unknown[]) => scheduleDrain(...args) }));

const { POST } = await import("../route");
const { EngineRejectedActionError } = await import("@/lib/game/advance");
const { GameRepositoryError } = await import("@/lib/game/repository");

const ID = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const post = (body: string | undefined, id = ID) =>
  POST(new Request(`http://localhost/api/games/${id}/advance`, { method: "POST", body }), { params: Promise.resolve({ id }) });

describe("POST /api/games/[id]/advance", () => {
  beforeEach(() => {
    advanceGame.mockReset();
    scheduleDrain.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("400 si el cuerpo no es { expectedVersion: entero ≥ 1 }", async () => {
    for (const body of [undefined, "", "no-json", "{}", '{"expectedVersion":0}', '{"expectedVersion":1.5}', '{"expectedVersion":"1"}', '{"expectedVersion":1,"x":2}']) {
      const response = await post(body);
      expect(response.status, String(body)).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_body");
    }
    expect(advanceGame).not.toHaveBeenCalled();
  });

  it("200 con la nueva versión, la acción, los eventos y el estado; sin caché", async () => {
    const state = createGame([...CHARACTER_IDS]);
    advanceGame.mockResolvedValue({
      kind: "advanced",
      action: { type: "roll", playerId: "ai-pink", value: 3 },
      events: [{ type: "dice_rolled", playerId: "ai-pink", value: 3 }],
      game: { id: ID, version: 8, status: "playing", winner: null, state } as never,
    });
    const response = await post('{"expectedVersion":7}');
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: ID, version: 8, status: "playing", winner: null,
      action: { type: "roll", playerId: "ai-pink", value: 3 },
      events: [{ type: "dice_rolled", playerId: "ai-pink", value: 3 }],
      state,
    });
    expect(advanceGame.mock.calls[0][0]).toBe(ID);
    expect(advanceGame.mock.calls[0][1]).toBe(7);
  });

  it("el dado lo genera el servidor (1..6) y cada petición usa un token distinto", async () => {
    advanceGame.mockResolvedValue({ kind: "not_found" });
    await post('{"expectedVersion":1}');
    await post('{"expectedVersion":1}');
    const [first, second] = advanceGame.mock.calls.map((c) => c[2]);
    const values = new Set(Array.from({ length: 600 }, () => first.rollDie()));
    expect([...values].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.newToken()).not.toBe(second.newToken());
  });

  it("404, y 409 con código y versión actual para cada conflicto (sin cambios en la partida)", async () => {
    const cases: [AdvanceResult, number, string, number | undefined][] = [
      [{ kind: "not_found" }, 404, "not_found", undefined],
      [{ kind: "game_finished", version: 640 }, 409, "game_finished", 640],
      [{ kind: "version_conflict", currentVersion: 9 }, 409, "version_conflict", 9],
      [{ kind: "turn_in_progress" }, 409, "turn_in_progress", undefined],
      [{ kind: "lease_expired" }, 409, "lease_expired", undefined],
    ];
    for (const [result, status, code, currentVersion] of cases) {
      advanceGame.mockResolvedValueOnce(result);
      const response = await post('{"expectedVersion":3}');
      expect(response.status, code).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(body.currentVersion).toBe(currentVersion);
    }
  });

  it("errores internos: 500 si el motor rechaza la acción, 503 si falla la BD; sin detalles", async () => {
    advanceGame.mockRejectedValueOnce(new EngineRejectedActionError("El motor rechazó move: BLOCKADE_IN_PATH"));
    let response = await post('{"expectedVersion":2}');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("BLOCKADE");

    advanceGame.mockRejectedValueOnce(new GameRepositoryError("database", "Error de base de datos al guardar la acción", "40001"));
    response = await post('{"expectedVersion":2}');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("40001");
  });

  it("chat: el procesador se programa (sin esperarlo) solo si la partida avanza con algo que comentar", async () => {
    const state = createGame([...CHARACTER_IDS]);
    const advanced = (version: number, events: GameEvent[]) => ({
      kind: "advanced" as const,
      action: { type: "roll" as const, playerId: "ai-pink", value: 5 },
      events,
      game: { id: ID, version, status: "playing", winner: null, state } as never,
    });
    const capture: GameEvent = { type: "piece_captured", playerId: "ai-pink", victimId: "ai-blue", victimPieceIndex: 0, cell: 30 };

    advanceGame.mockResolvedValueOnce(advanced(5, [capture]));
    expect((await post('{"expectedVersion":4}')).status).toBe(200);
    expect(scheduleDrain).toHaveBeenCalledExactlyOnceWith(ID);

    // Tirada normal: la versión queda en la cola (la encola PostgreSQL) y se procesa en el siguiente lote.
    advanceGame.mockResolvedValueOnce(advanced(7, [{ type: "dice_rolled", playerId: "ai-pink", value: 5 }]));
    expect((await post('{"expectedVersion":6}')).status).toBe(200);
    expect(scheduleDrain).toHaveBeenCalledTimes(1);

    advanceGame.mockResolvedValueOnce({ kind: "version_conflict", currentVersion: 8 });
    expect((await post('{"expectedVersion":6}')).status).toBe(409);
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });

  describe("selector estratégico de movimientos (fase 8.3)", () => {
    const PREVIEW = {
      VERCEL: "1",
      VERCEL_ENV: "preview",
      MOVES_LLM_ENABLED: "true",
      AI_GATEWAY_API_KEY: "clave-de-prueba",
      MOVES_LLM_MODEL: "nvidia/nemotron-3.5-lightning-free",
      // Upstash para el cupo de 20 consultas (F4). Credenciales falsas: aquí no se llama a Redis.
      UPSTASH_REDIS_REST_URL: "https://ejemplo.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token-falso-de-upstash",
    };
    const conflict = { kind: "version_conflict", currentVersion: 8 } as const;
    const stub = (env: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    };

    it("sin configurar (local, pruebas): no se pasa selector; se usa la estrategia local", async () => {
      advanceGame.mockResolvedValueOnce(conflict);
      await post('{"expectedVersion":7}');
      expect(advanceGame.mock.calls[0][2].moveSelector).toBeUndefined();
    });

    it("en Vercel Preview con la configuración válida: se pasa el selector, la señal de la petición y el aviso de reserva local", async () => {
      stub(PREVIEW);
      try {
        advanceGame.mockResolvedValueOnce(conflict);
        await post('{"expectedVersion":7}');
        const deps = advanceGame.mock.calls[0][2];
        expect(typeof deps.moveSelector?.select).toBe("function");
        expect(typeof deps.moveQuota?.tryConsume).toBe("function");
        expect(deps.signal).toBeInstanceOf(AbortSignal);
        expect(typeof deps.onMoveFallback).toBe("function");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("en Production (o con el modelo distinto): sin selector, y la configuración incorrecta se registra sin valores", async () => {
      for (const env of [{ ...PREVIEW, VERCEL_ENV: "production" }, { ...PREVIEW, MOVES_LLM_MODEL: "otro/modelo" }]) {
        stub(env);
        try {
          advanceGame.mockReset();
          advanceGame.mockResolvedValueOnce(conflict);
          await post('{"expectedVersion":7}');
          expect(advanceGame.mock.calls[0][2].moveSelector, JSON.stringify(env)).toBeUndefined();
        } finally {
          vi.unstubAllEnvs();
        }
      }
      const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([l]) => String(l));
      expect(logged.some((l) => l.includes("[move-llm] configuración"))).toBe(true);
      expect(logged.every((l) => !l.includes("clave-de-prueba"))).toBe(true);
    });

    it("en Preview sin Upstash (sin cupo verificable): sin selector ni cupo, y se registra sin valores", async () => {
      stub({ ...PREVIEW, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined });
      try {
        advanceGame.mockResolvedValueOnce(conflict);
        await post('{"expectedVersion":7}');
        expect(advanceGame.mock.calls[0][2].moveSelector).toBeUndefined();
        expect(advanceGame.mock.calls[0][2].moveQuota).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
      const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([l]) => String(l));
      expect(logged.some((l) => l.includes("[move-llm] configuración: configuración sin_upstash"))).toBe(true);
      expect(logged.every((l) => !l.includes("clave-de-prueba") && !l.includes("token-falso"))).toBe(true);
    });

    it("activar el chat no activa el selector de movimientos", async () => {
      stub({ VERCEL: "1", VERCEL_ENV: "preview", CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: "clave-de-prueba", CHAT_LLM_MODEL: "nvidia/nemotron-3.5-lightning-free" });
      try {
        advanceGame.mockResolvedValueOnce(conflict);
        await post('{"expectedVersion":7}');
        expect(advanceGame.mock.calls[0][2].moveSelector).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
