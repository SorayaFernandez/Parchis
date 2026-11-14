// Cupo de movimientos sobre el limitador global (sustituye al script propio de F4). La semántica del
// limitador (ventana, cupo por partida, concurrencia, caducidad y devolución) se prueba en
// `src/lib/llm/__tests__/` (doble en memoria y Redis real en Docker); aquí, la traducción a `QuotaResult`.
import { describe, expect, it, vi } from "vitest";
import { createGatewayLimiter, type AcquireResult, type GatewayLimiter } from "@/lib/llm/gatewayLimiter";
import { LIMITER_KEYS } from "@/lib/llm/limiterScripts";
import { memoryLimiterRedis } from "@/lib/llm/__tests__/memoryLimiterRedis";
import { MOVES_LLM_QUOTA, createLimitedMoveQuota } from "../quota";

vi.mock("server-only", () => ({}));

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

const fixed = (result: AcquireResult): GatewayLimiter => ({
  acquire: async () => result,
  reportRateLimited: async () => {},
  refundMovesGrant: async () => true,
});

describe("createLimitedMoveQuota", () => {
  it("el cupo sigue siendo 20 por partida, 7 días y 1 s de tiempo máximo de Redis", () => {
    expect(MOVES_LLM_QUOTA).toEqual({ limit: 20, ttlMs: 7 * 24 * 60 * 60 * 1000, timeoutMs: 1_000 });
  });

  it("traduce cada resultado del limitador", async () => {
    const allowed = await createLimitedMoveQuota(fixed({ kind: "allowed", grant: { gameId: GAME, grantId: "g1", used: 7 } })).tryConsume(GAME);
    expect(allowed).toMatchObject({ kind: "allowed", used: 7 });
    expect(typeof (allowed as { refund?: unknown }).refund).toBe("function");
    expect(await createLimitedMoveQuota(fixed({ kind: "quota_exhausted" })).tryConsume(GAME)).toEqual({ kind: "exhausted" });
    expect(await createLimitedMoveQuota(fixed({ kind: "rate_limited", scope: "global" })).tryConsume(GAME)).toEqual({ kind: "rate_limited", reason: "global" });
    expect(await createLimitedMoveQuota(fixed({ kind: "rate_limited", scope: "consumer" })).tryConsume(GAME)).toEqual({ kind: "rate_limited", reason: "consumer" });
    expect(await createLimitedMoveQuota(fixed({ kind: "blocked" })).tryConsume(GAME)).toEqual({ kind: "rate_limited", reason: "blocked" });
    expect(await createLimitedMoveQuota(fixed({ kind: "unavailable" })).tryConsume(GAME)).toEqual({ kind: "unavailable" });
    // Una concesión sin datos de la partida no se da por buena.
    expect(await createLimitedMoveQuota(fixed({ kind: "allowed", grant: null })).tryConsume(GAME)).toEqual({ kind: "unavailable" });
  });

  it("refund devuelve ESA concesión una sola vez (sobre el limitador real con el doble de Redis)", async () => {
    const m = memoryLimiterRedis();
    const quota = createLimitedMoveQuota(createGatewayLimiter(m.redis, { now: () => m.clock.now }));
    const first = await quota.tryConsume(GAME);
    const second = await quota.tryConsume(GAME);
    expect(first).toMatchObject({ kind: "allowed", used: 1 });
    expect(second).toMatchObject({ kind: "allowed", used: 2 });
    const refund = (first as { refund: () => Promise<boolean> }).refund;
    expect(await refund()).toBe(true);
    expect(await refund()).toBe(false);
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME))?.value).toBe("1");
    // La tercera de movimientos en la misma ventana se deniega (2 por consumidor): el hueco no se devolvió.
    expect(await quota.tryConsume(GAME)).toEqual({ kind: "rate_limited", reason: "consumer" });
  });
});
