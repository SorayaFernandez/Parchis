// Fase 8.3, F4: el cupo de 20 consultas por partida dentro de `advanceGame`, con el repositorio en
// memoria, un doble de Redis que reproduce el script atómico y sin llamar a AI Gateway.
import { describe, expect, it, vi } from "vitest";
import { createGame, getAvailableMoves, type GameState } from "@/lib/engine";
import { setup } from "@/lib/engine/__tests__/helpers";
import { advanceGame, type AdvanceDeps } from "../advance";
import { chooseMove, createSeededRandom } from "../ai";
import { CHARACTER_IDS } from "../characters";
import { MOVES_LLM } from "../moveSelector/config";
import type { MoveFallbackReason } from "../moveSelector/decide";
import { createMoveBreaker, createMoveSelector, MoveLlmError, type MoveSelector } from "../moveSelector/gateway";
import { QUOTA_SCRIPT, createMoveQuota, type MoveQuota, type QuotaRedis, type QuotaResult } from "../moveSelector/quota";
import { createMemoryRepository } from "./memoryRepository";

vi.mock("server-only", () => ({}));

const [BRAVA] = CHARACTER_IDS;
const twoOptions = (): GameState => ({ ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });
const oneOption = (): GameState => ({ ...setup({ pink: [20, -1, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });

/** Redis en memoria con la semántica atómica de QUOTA_SCRIPT. */
function memoryRedis(): QuotaRedis & { values: Map<string, number> } {
  const values = new Map<string, number>();
  return {
    values,
    async eval(script, [key], [limit]) {
      if (script !== QUOTA_SCRIPT) throw new Error("script desconocido");
      await Promise.resolve();
      const used = values.get(key) ?? 0;
      if (used >= Number(limit)) return -1;
      values.set(key, used + 1);
      return used + 1;
    },
  };
}

/** Cupo real (sobre el doble de Redis) que cuenta cuántas veces se intenta consumir. */
function countingQuota(redis = memoryRedis()) {
  const inner = createMoveQuota(redis, { prefix: "parchis:rl:test" });
  const attempts: QuotaResult[] = [];
  const quota: MoveQuota = {
    tryConsume: async (id) => {
      const result = await inner.tryConsume(id);
      attempts.push(result);
      return result;
    },
  };
  return { quota, attempts, redis };
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
      expect(q.attempts).toEqual([{ kind: "allowed", used: 1 }]);
    }
  });
});

describe("F4: sin cupo, estrategia local sin consultar al modelo", () => {
  it.each([
    ["cupo agotado", (): MoveQuota => ({ tryConsume: async () => ({ kind: "exhausted" }) }), "cupo agotado"],
    ["Redis no disponible", (): MoveQuota => createMoveQuota({ eval: async () => { throw new Error("caído"); } }, { prefix: "p" }), "cupo no disponible"],
    ["respuesta inesperada de Redis", (): MoveQuota => createMoveQuota({ eval: async () => "OK" }, { prefix: "p" }), "cupo no disponible"],
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
    expect(q.redis.values.get(`parchis:rl:test:moves-llm:${id}`)).toBe(20);
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
    expect(redis.values.get(`parchis:rl:test:moves-llm:${ga.id}`)).toBe(20);
    expect(redis.values.get(`parchis:rl:test:moves-llm:${gb.id}`)).toBe(20);
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
