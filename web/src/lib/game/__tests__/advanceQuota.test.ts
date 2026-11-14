// Fase 8.3: el cupo de 20 consultas por partida y el limitador global (compartido con el chat) dentro de
// `advanceGame`, con el repositorio en memoria, el limitador real sobre un doble de Redis con la semántica
// de sus scripts Lua y sin llamar a AI Gateway.
import { describe, expect, it, vi } from "vitest";
import { createGame, getAvailableMoves, type GameState } from "@/lib/engine";
import { setup } from "@/lib/engine/__tests__/helpers";
import { advanceGame, type AdvanceDeps } from "../advance";
import { chooseMove, createSeededRandom } from "../ai";
import { CHARACTER_IDS } from "../characters";
import { MOVES_LLM } from "../moveSelector/config";
import type { MoveFallbackReason } from "../moveSelector/decide";
import { createMoveBreaker, createMoveSelector, MoveLlmError, type MoveSelector } from "../moveSelector/gateway";
import { createLimitedMoveQuota, type MoveQuota, type QuotaResult } from "../moveSelector/quota";
import { createGatewayLimiter, type GatewayLimiterOptions } from "@/lib/llm/gatewayLimiter";
import { LIMITER_KEYS } from "@/lib/llm/limiterScripts";
import { memoryLimiterRedis } from "@/lib/llm/__tests__/memoryLimiterRedis";
import { createMemoryRepository } from "./memoryRepository";

vi.mock("server-only", () => ({}));

const [BRAVA] = CHARACTER_IDS;
const twoOptions = (): GameState => ({ ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });
const oneOption = (): GameState => ({ ...setup({ pink: [20, -1, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });

/** Doble de Redis del limitador (sin latencia: partidas completas). */
const memoryRedis = () => memoryLimiterRedis(undefined, { latency: false });
/** Sin límite global efectivo: estas pruebas miden el cupo por partida (el límite global, más abajo). */
const ROOMY: GatewayLimiterOptions = { globalLimit: 1_000_000, consumerLimit: 1_000_000 };

/** Cupo real (limitador sobre el doble de Redis) que cuenta cuántas veces se intenta consumir. */
function countingQuota(m = memoryRedis(), options: GatewayLimiterOptions = ROOMY) {
  const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now, ...options });
  const inner = createLimitedMoveQuota(limiter);
  const attempts: QuotaResult[] = [];
  const quota: MoveQuota = {
    tryConsume: async (id) => {
      const result = await inner.tryConsume(id);
      attempts.push(result);
      return result;
    },
  };
  return { quota, attempts, m, limiter };
}

async function newGame(state: GameState) {
  const memory = createMemoryRepository();
  const game = await memory.repository.create(state);
  return { ...memory, id: game.id };
}

let tokens = 0;
const deps = (repository: AdvanceDeps["repository"], extra: Partial<AdvanceDeps> = {}): AdvanceDeps => ({
  repository,
  rollDie: () => 4,
  newToken: () => `token-${++tokens}`,
  ...extra,
});

/** Selector que cuenta sus consultas y elige siempre la última opción. */
function lastOptionSelector() {
  let calls = 0;
  const selector: MoveSelector = {
    select: async (_s, decision) => {
      calls++;
      const option = decision.options[decision.options.length - 1];
      return { ok: true, id: option.id, pieceIndex: option.pieceIndex };
    },
  };
  return { selector, calls: () => calls };
}

describe("F4: cuándo se consume cupo", () => {
  it("no se consume al tirar, sin movimientos, con una sola opción ni sin selector", async () => {
    const q = countingQuota();
    const s = lastOptionSelector();
    // Tirada sin movimientos (todas en casa con un 3).
    const roll = await newGame(createGame([...CHARACTER_IDS]));
    await advanceGame(roll.id, 1, deps(roll.repository, { moveSelector: s.selector, moveQuota: q.quota, rollDie: () => 3 }));
    // Una sola opción.
    const one = await newGame(oneOption());
    await advanceGame(one.id, 1, deps(one.repository, { moveSelector: s.selector, moveQuota: q.quota }));
    // Dos opciones, pero sin selector: estrategia local directa.
    const local = await newGame(twoOptions());
    await advanceGame(local.id, 1, deps(local.repository, { moveQuota: q.quota }));
    expect(q.attempts).toEqual([]);
    expect(s.calls()).toBe(0);
  });

  it("con la petición ya cancelada no se consume cupo (no se va a consultar)", async () => {
    const q = countingQuota();
    const s = lastOptionSelector();
    const { repository, id } = await newGame(twoOptions());
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector, moveQuota: q.quota, signal: AbortSignal.abort() }));
    expect(result).toMatchObject({ kind: "advanced" });
    expect(q.attempts).toEqual([]);
    expect(s.calls()).toBe(0);
  });

  it("se consume al intentar una consulta real, aunque el modelo responda con error o agote el tiempo", async () => {
    for (const respond of [() => new Response("{}", { status: 503 }), () => "hang" as const]) {
      const q = countingQuota();
      const fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
        const r = respond();
        if (r === "hang") return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
        return r;
      });
      const selector = createMoveSelector({
        config: { enabled: true, apiKey: "clave-de-prueba", model: MOVES_LLM.model, provider: null },
        fetch: fetch as unknown as typeof globalThis.fetch,
        breaker: createMoveBreaker(),
        timeoutMs: 20,
      });
      const state = twoOptions();
      const { repository, id } = await newGame(state);
      const result = await advanceGame(id, 1, deps(repository, { moveSelector: selector, moveQuota: q.quota }));
      expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: chooseMove(state, getAvailableMoves(state)) } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(q.attempts).toHaveLength(1);
      expect(q.attempts[0]).toMatchObject({ kind: "allowed", used: 1 });
    }
  });
});

describe("F4: sin cupo, estrategia local sin consultar al modelo", () => {
  it.each([
    ["cupo agotado", (): MoveQuota => ({ tryConsume: async () => ({ kind: "exhausted" }) }), "cupo agotado"],
    ["Redis no disponible", (): MoveQuota => createLimitedMoveQuota(createGatewayLimiter({ eval: async () => { throw new Error("caído"); } })), "cupo no disponible"],
    ["respuesta inesperada de Redis", (): MoveQuota => createLimitedMoveQuota(createGatewayLimiter({ eval: async () => "OK" })), "cupo no disponible"],
    ["límite global (ventana llena)", (): MoveQuota => ({ tryConsume: async () => ({ kind: "rate_limited" }) }), "límite global"],
    ["cupo que lanza (no debería)", (): MoveQuota => ({ tryConsume: async () => { throw new Error("x"); } }), "cupo no disponible"],
  ])("%s: jugada local, sin llamar al selector, y la partida avanza sin errores", async (_, makeQuota, reason) => {
    const state = twoOptions();
    const { repository, id, rows } = await newGame(state);
    const s = lastOptionSelector();
    const reasons: MoveFallbackReason[] = [];
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector, moveQuota: makeQuota(), onMoveFallback: (r) => reasons.push(r) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: chooseMove(state, getAvailableMoves(state)) } });
    expect(s.calls()).toBe(0);
    expect(reasons).toEqual([reason]);
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 2 } });
  });

  it("selector sin cupo (falla cerrado): no se consulta", async () => {
    const s = lastOptionSelector();
    const { repository, id } = await newGame(twoOptions());
    const reasons: MoveFallbackReason[] = [];
    await advanceGame(id, 1, deps(repository, { moveSelector: s.selector, onMoveFallback: (r) => reasons.push(r) }));
    expect(s.calls()).toBe(0);
    expect(reasons).toEqual(["cupo no disponible"]);
  });
});

describe("F4: integración con F3 en partidas completas", () => {
  /** Juega una partida entera. Con `memory`, en ese repositorio (las partidas de un mismo repositorio tienen ids distintos). */
  async function play(seed: number, extra: Partial<AdvanceDeps>, memory = createMemoryRepository(), stop?: () => boolean) {
    const dice = createSeededRandom(seed);
    const random = createSeededRandom(seed + 1000);
    const { repository } = memory;
    const { id } = await repository.create(createGame([...CHARACTER_IDS]));
    let finished = false;
    for (let version = 1; version < 3000; version++) {
      if (stop?.()) break;
      const result = await advanceGame(id, version, deps(repository, { ...extra, rollDie: () => 1 + Math.floor(dice() * 6), random }));
      if (result.kind === "game_finished") {
        finished = true;
        break;
      }
      if (result.kind !== "advanced") throw new Error(result.kind);
    }
    return { id, finished };
  }

  it("se consulta al modelo exactamente 20 veces y, agotado el cupo, la partida sigue con la estrategia local hasta terminar", { timeout: 60_000 }, async () => {
    const q = countingQuota();
    const s = lastOptionSelector();
    const reasons: MoveFallbackReason[] = [];
    const { id, finished } = await play(5, { moveSelector: s.selector, moveQuota: q.quota, onMoveFallback: (r) => reasons.push(r) });
    expect(finished).toBe(true);
    expect(s.calls()).toBe(20);
    expect(q.attempts.filter((a) => a.kind === "allowed")).toHaveLength(20);
    expect(q.attempts.filter((a) => a.kind === "exhausted").length).toBeGreaterThan(0);
    expect(reasons.every((r) => r === "cupo agotado")).toBe(true);
    expect(q.m.getString(LIMITER_KEYS.movesQuota(id))?.value).toBe("20");
  });

  it("dos partidas en paralelo con el mismo Redis: cada una con su cupo de 20", { timeout: 60_000 }, async () => {
    const redis = memoryRedis();
    const memory = createMemoryRepository();
    const a = lastOptionSelector();
    const b = lastOptionSelector();
    const qa = countingQuota(redis);
    const qb = countingQuota(redis);
    // Cada partida se juega hasta que su cupo se ha agotado y se ha rechazado al menos una consulta más.
    const exhausted = (q: ReturnType<typeof countingQuota>) => () => q.attempts.some((x) => x.kind === "exhausted");
    const [ga, gb] = await Promise.all([
      play(5, { moveSelector: a.selector, moveQuota: qa.quota }, memory, exhausted(qa)),
      play(6, { moveSelector: b.selector, moveQuota: qb.quota }, memory, exhausted(qb)),
    ]);
    expect(ga.id).not.toBe(gb.id);
    expect(redis.getString(LIMITER_KEYS.movesQuota(ga.id))?.value).toBe("20");
    expect(redis.getString(LIMITER_KEYS.movesQuota(gb.id))?.value).toBe("20");
    expect(a.calls()).toBe(20);
    expect(b.calls()).toBe(20);
  });

  it("con un selector que siempre falla: se consumen las 20 consultas y después la partida sigue con la estrategia local", { timeout: 60_000 }, async () => {
    let selects = 0;
    const failing: MoveSelector = {
      select: async () => {
        selects++;
        return { ok: false, error: new MoveLlmError("timeout", "tiempo máximo agotado") };
      },
    };
    const q = countingQuota();
    // Se juega hasta 30 consultas rechazadas por cupo después de agotarlo: la partida sigue avanzando.
    await play(8, { moveSelector: failing, moveQuota: q.quota }, undefined, () => q.attempts.filter((x) => x.kind === "exhausted").length >= 30);
    expect(selects).toBe(20);
    expect(q.attempts.filter((x) => x.kind === "allowed")).toHaveLength(20);
  });
});

describe("límite global y 429 del proveedor", () => {
  /** Selector real de F2 con un fetch simulado que responde lo indicado. */
  function realSelector(respond: () => Response | "hang", onRateLimited?: (ms: number) => Promise<void>) {
    const fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const r = respond();
      if (r === "hang") return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      return r;
    });
    const selector = createMoveSelector({
      config: { enabled: true, apiKey: "clave-de-prueba", model: MOVES_LLM.model, provider: null },
      fetch: fetch as unknown as typeof globalThis.fetch,
      breaker: createMoveBreaker(),
      timeoutMs: 20,
      onRateLimited,
    });
    return { selector, fetch };
  }

  it("con la ventana de movimientos llena: jugada local sin llamar al modelo y sin gastar cupo", async () => {
    const m = memoryRedis();
    const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now });
    // Dos consultas de movimientos de otra partida llenan la parte de movimientos de la ventana.
    await limiter.acquire({ consumer: "moves", gameId: "3f39156e-12ec-4bd0-86af-58a5ccf8cd66" });
    await limiter.acquire({ consumer: "moves", gameId: "3f39156e-12ec-4bd0-86af-58a5ccf8cd66" });
    const s = lastOptionSelector();
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    const reasons: MoveFallbackReason[] = [];
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector, moveQuota: createLimitedMoveQuota(limiter), onMoveFallback: (r) => reasons.push(r) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: chooseMove(state, getAvailableMoves(state)) } });
    expect(s.calls()).toBe(0);
    expect(reasons).toEqual(["límite global"]);
    expect(m.getString(LIMITER_KEYS.movesQuota(id))).toBeUndefined();
  });

  it("429 del proveedor: bloqueo global (chat y movimientos), la consulta de la partida se devuelve una vez y el hueco global no", async () => {
    const m = memoryRedis();
    const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now });
    const { selector, fetch } = realSelector(
      () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
      (ms) => limiter.reportRateLimited(ms),
    );
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: selector, moveQuota: createLimitedMoveQuota(limiter) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: chooseMove(state, getAvailableMoves(state)) } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(m.getString(LIMITER_KEYS.movesQuota(id))?.value).toBe("0"); // devuelta
    expect(m.windowMembers(LIMITER_KEYS.window)).toHaveLength(1); // el hueco global sigue ocupado
    // Bloqueo global de 30 s: ni chat ni movimientos.
    expect((await limiter.acquire({ consumer: "chat" })).kind).toBe("blocked");
    expect((await limiter.acquire({ consumer: "moves", gameId: id })).kind).toBe("blocked");
    m.clock.now += 30_000;
    expect((await limiter.acquire({ consumer: "chat" })).kind).toBe("allowed");
  });

  it("5xx y timeout no devuelven la consulta de la partida (pudo procesarse) ni bloquean a los demás", async () => {
    for (const respond of [() => new Response("{}", { status: 503 }), () => "hang" as const]) {
      const m = memoryRedis();
      const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now });
      const blocked = vi.fn(async (ms: number) => limiter.reportRateLimited(ms));
      const { selector } = realSelector(respond, blocked);
      const { repository, id } = await newGame(twoOptions());
      await advanceGame(id, 1, deps(repository, { moveSelector: selector, moveQuota: createLimitedMoveQuota(limiter) }));
      expect(m.getString(LIMITER_KEYS.movesQuota(id))?.value).toBe("1");
      expect(blocked).not.toHaveBeenCalled();
      expect((await limiter.acquire({ consumer: "chat" })).kind).toBe("allowed");
    }
  });
});
