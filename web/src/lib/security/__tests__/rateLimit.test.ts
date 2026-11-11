import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// @upstash/ratelimit simulado: se controla qué devuelve cada llamada a limit().
const limitMock = vi.fn();
const constructed: unknown[] = [];
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow(limit: number, window: string) {
      return { limit, window };
    }
    constructor(options: unknown) {
      constructed.push(options);
    }
    limit(identifier: string) {
      return limitMock(identifier);
    }
  },
}));

const {
  DEFAULT_RULES,
  checkRateLimits,
  createUpstashLimiter,
  disabledLimiter,
  identifierFor,
  loadRules,
  rateLimitResponse,
} = await import("../rateLimit");
const { createFakeLimiter } = await import("./fakeLimiter");

describe("reglas", () => {
  it("valores por defecto documentados y fail-closed solo para crear partidas", () => {
    expect(DEFAULT_RULES.create).toMatchObject({ limit: 5, windowSec: 600, failMode: "closed" });
    expect(DEFAULT_RULES.advanceGame).toMatchObject({ limit: 180, windowSec: 60, failMode: "open" });
    expect(DEFAULT_RULES.advanceIp).toMatchObject({ limit: 600, windowSec: 60, failMode: "open" });
    expect(DEFAULT_RULES.read).toMatchObject({ limit: 120, windowSec: 60, failMode: "open" });
  });

  it("se pueden cambiar por entorno con '<n>/<segundos>'; los valores inválidos se ignoran", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = loadRules({ RATE_LIMIT_CREATE: "10/300", RATE_LIMIT_READ: "muchos", RATE_LIMIT_ADVANCE_GAME: "0/60" });
    expect(rules.create).toMatchObject({ limit: 10, windowSec: 300, failMode: "closed" });
    expect(rules.read).toEqual(DEFAULT_RULES.read);
    expect(rules.advanceGame).toEqual(DEFAULT_RULES.advanceGame);
  });
});

describe("checkRateLimits", () => {
  const rule = { ...DEFAULT_RULES.read, limit: 3, windowSec: 10 };

  it("dentro del límite: permite; al superarlo: 'limited' con el tiempo hasta liberar plaza", async () => {
    const { limiter, clock } = createFakeLimiter();
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimits([{ rule, key: ["1.2.3.4"] }], limiter)).toEqual({ kind: "allow" });
      clock.now += 1000;
    }
    expect(await checkRateLimits([{ rule, key: ["1.2.3.4"] }], limiter)).toEqual({ kind: "limited", retryAfterSec: 7 });
    clock.now += 7000; // la primera petición sale de la ventana
    expect(await checkRateLimits([{ rule, key: ["1.2.3.4"] }], limiter)).toEqual({ kind: "allow" });
  });

  it("claves distintas tienen cupos distintos", async () => {
    const { limiter } = createFakeLimiter();
    for (let i = 0; i < 3; i++) await checkRateLimits([{ rule, key: ["a"] }], limiter);
    expect((await checkRateLimits([{ rule, key: ["a"] }], limiter)).kind).toBe("limited");
    expect((await checkRateLimits([{ rule, key: ["b"] }], limiter)).kind).toBe("allow");
  });

  it("varias reglas: gana la más restrictiva (mayor Retry-After)", async () => {
    const { limiter } = createFakeLimiter();
    const other = { ...DEFAULT_RULES.advanceIp, limit: 1, windowSec: 30 };
    await checkRateLimits([{ rule, key: ["x"] }, { rule: other, key: ["x"] }], limiter);
    expect(await checkRateLimits([{ rule, key: ["x"] }, { rule: other, key: ["x"] }], limiter)).toEqual({ kind: "limited", retryAfterSec: 30 });
  });

  it("proveedor caído: fail-closed rechaza, fail-open deja pasar; sin proveedor, siempre permite", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { limiter } = createFakeLimiter();
    limiter.setFailing(true);
    expect(await checkRateLimits([{ rule: DEFAULT_RULES.create, key: ["x"] }], limiter)).toEqual({ kind: "unavailable" });
    expect(await checkRateLimits([{ rule: DEFAULT_RULES.read, key: ["x"] }], limiter)).toEqual({ kind: "allow" });
    expect(await checkRateLimits([{ rule: DEFAULT_RULES.create, key: ["x"] }], disabledLimiter)).toEqual({ kind: "allow" });
  });
});

describe("respuestas", () => {
  it("429 con Retry-After, sin caché y sin datos internos; 503 si el proveedor falla en fail-closed", async () => {
    const limited = rateLimitResponse({ kind: "limited", retryAfterSec: 42 })!;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toEqual({ error: { code: "rate_limited", message: "Demasiadas peticiones. Espera un momento e inténtalo de nuevo." } });

    const unavailable = rateLimitResponse({ kind: "unavailable" })!;
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("30");
    expect(rateLimitResponse({ kind: "allow" })).toBeNull();
  });
});

describe("adaptador de Upstash", () => {
  beforeEach(() => {
    limitMock.mockReset();
    constructed.length = 0;
  });
  const redis = {} as never;
  const rule = DEFAULT_RULES.advanceGame;

  it("traduce la respuesta de Upstash (permitido, límite con reset, timeout y error)", async () => {
    const limiter = createUpstashLimiter(redis, { now: () => 1_000_000 });
    limitMock.mockResolvedValueOnce({ success: true, reset: 0 });
    expect(await limiter.check(rule, "k")).toEqual({ kind: "allowed" });
    limitMock.mockResolvedValueOnce({ success: false, reset: 1_012_400 });
    expect(await limiter.check(rule, "k")).toEqual({ kind: "limited", retryAfterSec: 13 });
    limitMock.mockResolvedValueOnce({ success: true, reset: 0, reason: "timeout" }); // Upstash deja pasar al agotar el tiempo
    expect(await limiter.check(rule, "k")).toEqual({ kind: "unavailable" });
    limitMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await limiter.check(rule, "k")).toEqual({ kind: "unavailable" });
  });

  it("una instancia por regla (ventana deslizante, prefijo propio, timeout corto) y sin IP en claro", async () => {
    const limiter = createUpstashLimiter(redis);
    limitMock.mockResolvedValue({ success: true, reset: 0 });
    await limiter.check(rule, '["203.0.113.7","partida"]');
    await limiter.check(rule, '["203.0.113.8","partida"]');
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ limiter: { limit: 180, window: "60 s" }, prefix: "parchis:rl", timeout: 1000, analytics: false });
    const identifier = limitMock.mock.calls[0][0] as string;
    expect(identifier).toMatch(/^advanceGame:[0-9a-f]{32}$/);
    expect(identifier).not.toContain("203.0.113.7");
    expect(identifierFor(rule, "a")).not.toBe(identifierFor(rule, "b"));
  });
});

describe("getRateLimiter", () => {
  it("sin credenciales: desactivado (y en Vercel lo avisa); con credenciales válidas: Upstash", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const fresh = await import("../rateLimit");
    expect(fresh.getRateLimiter({}).enabled).toBe(false);
    expect(fresh.getRateLimiter({ VERCEL: "1", UPSTASH_REDIS_REST_URL: "no-es-url" }).enabled).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("DESACTIVADO"));
    const limiter = fresh.getRateLimiter({ KV_REST_API_URL: "https://ejemplo.upstash.io", KV_REST_API_TOKEN: "token-ficticio-123" });
    expect(limiter.enabled).toBe(true);
  });
});
