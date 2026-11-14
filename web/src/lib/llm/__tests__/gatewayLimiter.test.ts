import { describe, expect, it, vi } from "vitest";
import { blockDuration, createGatewayLimiter, getGatewayLimiter, type AcquireResult } from "../gatewayLimiter";
import { LIMITER_KEYS, LLM_GATEWAY_LIMITS } from "../limiterScripts";
import { memoryLimiterRedis } from "./memoryLimiterRedis";

vi.mock("server-only", () => ({}));

const GAME_A = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const GAME_B = "3f39156e-12ec-4bd0-86af-58a5ccf8cd66";
let ids = 0;
const make = (m = memoryLimiterRedis(), options = {}) => ({ m, limiter: createGatewayLimiter(m.redis, { newId: () => `g${++ids}`, now: () => m.clock.now, ...options }) });
const moves = (gameId = GAME_A) => ({ consumer: "moves" as const, gameId });
const chat = { consumer: "chat" as const };
const kinds = (results: AcquireResult[]) => results.map((r) => r.kind);

describe("límites acordados", () => {
  it("4 por ventana de 60 s entre los dos, 2 por consumidor y 20 por partida", () => {
    expect(LLM_GATEWAY_LIMITS).toMatchObject({ globalLimit: 4, consumerLimit: 2, windowMs: 60_000, movesPerGame: 20 });
    expect(LIMITER_KEYS.window).toBe("{parchis-llm}:gateway:window"); // sin prefijo del entorno
  });
});

describe("ventana deslizante global y por consumidor", () => {
  it("cada consumidor tiene como mucho 2 y, entre los dos, 4; la 5.ª se deniega", async () => {
    const { limiter } = make();
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await limiter.acquire(chat));
    for (let i = 0; i < 3; i++) results.push(await limiter.acquire(moves()));
    expect(kinds(results)).toEqual(["allowed", "allowed", "rate_limited", "allowed", "allowed", "rate_limited"]);
  });

  it("la ventana es deslizante: cada hueco vuelve a los 60 s de su propia concesión", async () => {
    const { m, limiter } = make();
    await limiter.acquire(chat); // t0
    m.clock.now += 30_000;
    await limiter.acquire(chat); // t0 + 30 s
    expect((await limiter.acquire(chat)).kind).toBe("rate_limited");
    m.clock.now += 30_000; // t0 + 60 s: sale la primera
    expect((await limiter.acquire(chat)).kind).toBe("allowed");
    expect((await limiter.acquire(chat)).kind).toBe("rate_limited");
    m.clock.now += 30_000; // t0 + 90 s: sale la segunda
    expect((await limiter.acquire(chat)).kind).toBe("allowed");
  });

  it("en ningún intervalo de 60 s hay más de 4 concesiones (simulación de 10 minutos con peticiones de ambos)", async () => {
    const { m, limiter } = make(memoryLimiterRedis(undefined, { latency: false }));
    const granted: number[] = [];
    for (let t = 0; t < 600; t++) {
      for (const req of [chat, moves(), chat, moves()]) {
        if ((await limiter.acquire(req)).kind === "allowed") granted.push(m.clock.now);
      }
      m.clock.now += 1_000;
    }
    for (const start of granted) expect(granted.filter((g) => g >= start && g < start + 60_000).length).toBeLessThanOrEqual(4);
    expect(granted.length).toBeGreaterThanOrEqual(36); // ~4 por minuto aprovechados
  });

  it("peticiones concurrentes (40 a la vez desde varios clientes) no superan los límites", async () => {
    const m = memoryLimiterRedis();
    const clients = [0, 1, 2].map(() => createGatewayLimiter(m.redis, { now: () => m.clock.now }));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => clients[i % 3].acquire(i % 2 ? chat : moves())));
    expect(results.filter((r) => r.kind === "allowed")).toHaveLength(4);
    expect(m.windowMembers(LIMITER_KEYS.window).filter((x) => x.startsWith("chat:"))).toHaveLength(2);
    expect(m.windowMembers(LIMITER_KEYS.window).filter((x) => x.startsWith("moves:"))).toHaveLength(2);
  });
});

describe("cupo de movimientos por partida", () => {
  const roomy = { globalLimit: 1_000, consumerLimit: 1_000 }; // aísla el cupo del límite global

  it("de 0 a 20 (la 20 se concede con su número; la 21 se rechaza) y partidas independientes", async () => {
    const { m, limiter } = make(undefined, roomy);
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await limiter.acquire(moves()));
    expect(results.slice(0, 20).map((r) => (r.kind === "allowed" ? r.grant?.used : null))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results[20].kind).toBe("quota_exhausted");
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("20");
    expect((await limiter.acquire(moves(GAME_B))).kind).toBe("allowed");
  });

  it("una denegación global no gasta cupo; un cupo agotado no ocupa la ventana", async () => {
    const { m, limiter } = make();
    await limiter.acquire(moves());
    await limiter.acquire(moves());
    expect((await limiter.acquire(moves())).kind).toBe("rate_limited");
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("2");
    // Partida B con el cupo agotado: no entra en la ventana.
    const b = make(m, { globalLimit: 1_000, consumerLimit: 1_000 });
    for (let i = 0; i < 20; i++) await b.limiter.acquire(moves(GAME_B));
    m.clock.now += 60_000; // ventana vacía
    expect((await limiter.acquire(moves(GAME_B))).kind).toBe("quota_exhausted");
    expect(m.windowMembers(LIMITER_KEYS.window)).toEqual([]);
  });

  it("30 peticiones concurrentes de una partida: exactamente 20 concedidas, con números 1…20 sin repetir", async () => {
    const m = memoryLimiterRedis();
    const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now, ...roomy });
    const results = await Promise.all(Array.from({ length: 30 }, () => limiter.acquire(moves())));
    const used = results.flatMap((r) => (r.kind === "allowed" && r.grant ? [r.grant.used] : []));
    expect([...used].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results.filter((r) => r.kind === "quota_exhausted")).toHaveLength(10);
  });

  it("el cupo caduca a los 7 días de la primera consulta y la marca de cada concesión no le sobrevive", async () => {
    const { m, limiter } = make(undefined, { ...roomy, movesQuotaTtlMs: 10_000, grantTtlMs: 60_000 });
    const first = await limiter.acquire(moves());
    expect(first.kind).toBe("allowed");
    m.clock.now += 9_000;
    const second = await limiter.acquire(moves());
    // La marca de la segunda caduca con el contador (1 s), no a los 60 s.
    expect(m.getString(LIMITER_KEYS.movesGrant((second as { grant: { grantId: string } }).grant.grantId))?.expiresAt).toBe(m.clock.now + 1_000);
    m.clock.now += 1_000;
    expect(await limiter.acquire(moves())).toMatchObject({ kind: "allowed", grant: { used: 1 } });
  });
});

describe("devolución idempotente ante un 429", () => {
  it("devuelve una concesión una sola vez, sin tocar otras ni la ventana global", async () => {
    const { m, limiter } = make();
    const a = await limiter.acquire(moves());
    const b = await limiter.acquire(moves());
    if (a.kind !== "allowed" || !a.grant || b.kind !== "allowed" || !b.grant) throw new Error("sin concesión");
    expect(await limiter.refundMovesGrant(a.grant)).toBe(true);
    expect(await limiter.refundMovesGrant(a.grant)).toBe(false); // segunda vez: nada
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("1");
    expect(m.windowMembers(LIMITER_KEYS.window)).toHaveLength(2); // el hueco global no se devuelve
    expect(await limiter.refundMovesGrant(b.grant)).toBe(true);
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("0");
  });

  it("10 devoluciones concurrentes de la misma concesión: solo una cuenta", async () => {
    const { m, limiter } = make();
    const a = await limiter.acquire(moves());
    if (a.kind !== "allowed" || !a.grant) throw new Error("sin concesión");
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.refundMovesGrant(a.grant!)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("0");
  });

  it("con el contador caducado no devuelve nada ni deja valores negativos", async () => {
    const { m, limiter } = make(undefined, { movesQuotaTtlMs: 5_000 });
    const a = await limiter.acquire(moves());
    if (a.kind !== "allowed" || !a.grant) throw new Error("sin concesión");
    m.clock.now += 5_000;
    expect(await limiter.refundMovesGrant(a.grant)).toBe(false);
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))).toBeUndefined();
  });

  it("una concesión inventada (sin marca) no devuelve nada", async () => {
    const { m, limiter } = make();
    await limiter.acquire(moves());
    expect(await limiter.refundMovesGrant({ gameId: GAME_A, grantId: "inventada", used: 1 })).toBe(false);
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))?.value).toBe("1");
  });
});

describe("bloqueo global tras un 429", () => {
  it("bloquea a los dos consumidores durante el Retry-After y después se puede volver a llamar", async () => {
    const { m, limiter } = make();
    await limiter.reportRateLimited(20_000);
    expect((await limiter.acquire(chat)).kind).toBe("blocked");
    expect((await limiter.acquire(moves())).kind).toBe("blocked");
    expect(m.getString(LIMITER_KEYS.movesQuota(GAME_A))).toBeUndefined(); // bloqueado: no gasta cupo
    m.clock.now += 20_000;
    expect((await limiter.acquire(chat)).kind).toBe("allowed");
  });

  it("una respuesta tardía con un Retry-After más corto no acorta un bloqueo más largo", async () => {
    const { m, limiter } = make();
    await limiter.reportRateLimited(60_000);
    await limiter.reportRateLimited(5_000);
    m.clock.now += 30_000;
    expect((await limiter.acquire(chat)).kind).toBe("blocked");
    // Uno más largo sí lo amplía.
    await limiter.reportRateLimited(120_000);
    m.clock.now += 60_000;
    expect((await limiter.acquire(chat)).kind).toBe("blocked");
  });

  it("duración acotada: Retry-After a 1 s–1 h, y 60 s si no es válido", () => {
    expect(blockDuration(20_000)).toBe(20_000);
    expect(blockDuration(10)).toBe(1_000);
    expect(blockDuration(99 * 3_600_000)).toBe(3_600_000);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(blockDuration(bad)).toBe(60_000);
  });
});

describe("Redis no disponible: nunca se asume que hay permiso", () => {
  it("error, error síncrono, sin respuesta a tiempo o respuesta inesperada → unavailable", async () => {
    const cases: ((...a: unknown[]) => Promise<unknown>)[] = [
      async () => { throw new Error("ECONNRESET"); },
      (() => { throw new Error("síncrono"); }) as never,
      () => new Promise(() => {}),
      ...["0", null, undefined, 21, -9, 1.5, Number.NaN, { ok: 1 }, [0]].map((v) => async () => v),
    ];
    for (const evalFn of cases) {
      const limiter = createGatewayLimiter({ eval: evalFn }, { timeoutMs: 20 });
      expect((await limiter.acquire(moves())).kind).toBe("unavailable");
      expect((await limiter.acquire(chat)).kind).toBe("unavailable");
      expect(await limiter.refundMovesGrant({ gameId: GAME_A, grantId: "x", used: 1 })).toBe(false);
      await expect(limiter.reportRateLimited(1_000)).resolves.toBeUndefined();
    }
  });

  it("el chat no recibe un número de movimientos como permiso, ni un id de partida inválido toca Redis", async () => {
    expect((await createGatewayLimiter({ eval: async () => 3 }).acquire(chat)).kind).toBe("unavailable");
    const m = memoryLimiterRedis();
    expect((await createGatewayLimiter(m.redis).acquire({ consumer: "moves", gameId: "no-uuid" })).kind).toBe("unavailable");
    expect(m.evals).toHaveLength(0);
  });

  it("en Redis solo hay ids, instantes y contadores (ni prompts ni mensajes)", async () => {
    const { m, limiter } = make();
    await limiter.acquire(chat);
    await limiter.acquire(moves());
    for (const e of m.evals) for (const value of [...e.keys, ...e.args]) expect(String(value)).toMatch(/^[{}a-z0-9:_-]*$|^\d+$|^(chat|moves)$/i);
  });
});

describe("getGatewayLimiter", () => {
  it("sin credenciales válidas de Upstash: null; con ellas (también KV), un limitador por proceso", () => {
    expect(getGatewayLimiter({})).toBeNull();
    expect(getGatewayLimiter({ UPSTASH_REDIS_REST_URL: "http://inseguro.example", UPSTASH_REDIS_REST_TOKEN: "token-largo-de-prueba" })).toBeNull();
    const env = { UPSTASH_REDIS_REST_URL: "https://ejemplo.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token-largo-de-prueba" };
    const first = getGatewayLimiter(env);
    expect(first).not.toBeNull();
    expect(getGatewayLimiter(env)).toBe(first);
    expect(getGatewayLimiter({ KV_REST_API_URL: "https://otro.upstash.io", KV_REST_API_TOKEN: "otro-token-largo" })).not.toBeNull();
  });
});

describe("observabilidad: motivo de cada denegación, reloj y resumen agregado", () => {
  it("el límite se distingue: global (4 entre los dos) frente al del consumidor (2)", async () => {
    const { limiter } = make();
    await limiter.acquire(chat);
    await limiter.acquire(chat);
    expect(await limiter.acquire(chat)).toEqual({ kind: "rate_limited", scope: "consumer" });
    await limiter.acquire(moves());
    await limiter.acquire(moves());
    expect(await limiter.acquire(chat)).toEqual({ kind: "rate_limited", scope: "global" });
    expect(await limiter.acquire(moves())).toEqual({ kind: "rate_limited", scope: "global" });
  });

  it("si el script no usa TIME de Redis, lo deja dicho (una vez por minuto) y el permiso funciona igual", async () => {
    const lines: string[] = [];
    const m = memoryLimiterRedis(undefined, { redisClock: false });
    const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now, log: (l) => lines.push(l) });
    expect((await limiter.acquire(chat)).kind).toBe("allowed");
    expect((await limiter.acquire(chat)).kind).toBe("allowed");
    expect(lines).toEqual(["[llm-limiter] aviso: TIME de Redis no disponible en el script; se usa la hora del cliente"]);
    m.clock.now += 60_000;
    await limiter.acquire(moves());
    expect(lines.filter((l) => l.includes("aviso"))).toHaveLength(2);
  });

  it("con TIME de Redis no hay aviso; una respuesta con un reloj desconocido es no disponible", async () => {
    const lines: string[] = [];
    const { limiter } = make(undefined, { log: (l: string) => lines.push(l) });
    await limiter.acquire(chat);
    expect(lines).toEqual([]);
    for (const reply of [[0, 2], [0], [0, 1, 1], ["0", 1], 0]) {
      expect((await createGatewayLimiter({ eval: async () => reply }, { log: () => {} }).acquire(chat)).kind, JSON.stringify(reply)).toBe("unavailable");
    }
  });

  it("resumen agregado en memoria: por consumidor y resultado, con el reloj, como mucho una vez por intervalo y sin datos sensibles", async () => {
    const lines: string[] = [];
    const m = memoryLimiterRedis(undefined, { latency: false });
    const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now, log: (l) => lines.push(l), summaryIntervalMs: 60_000 });
    await limiter.acquire(chat); // concedida
    await limiter.acquire(chat); // concedida
    await limiter.acquire(chat); // límite del chat
    await limiter.acquire(moves()); // concedida
    await limiter.acquire(moves()); // concedida
    await limiter.acquire(moves()); // límite global (ya hay 4)
    await limiter.reportRateLimited(5_000);
    expect(lines).toEqual([]); // aún dentro del intervalo
    m.clock.now += 4_000;
    await limiter.acquire(chat); // bloqueo
    m.clock.now += 60_000;
    await limiter.acquire({ consumer: "moves", gameId: "no-uuid" }); // no disponible; cierra el periodo
    expect(lines).toEqual([
      "[llm-limiter] resumen de este proceso (64 s): chat concedidas=2 límite-global=0 límite-consumidor=1 bloqueo=1 cupo-agotado=0 no-disponible=0 | movimientos concedidas=2 límite-global=1 límite-consumidor=0 bloqueo=0 cupo-agotado=0 no-disponible=1 | reloj redis=7 cliente=0",
    ]);
    // Ninguna llamada extra a Redis para el resumen: un EVAL por permiso (7 válidos) y uno del bloqueo.
    expect(m.evals.map((e) => e.script)).toEqual(["acquire", "acquire", "acquire", "acquire", "acquire", "acquire", "block", "acquire"]);
    for (const line of lines) expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|parchis-llm|clave/);
    // El siguiente periodo empieza de cero.
    m.clock.now += 60_000;
    await limiter.acquire(chat);
    expect(lines[1]).toContain("chat concedidas=1");
    expect(lines[1]).toContain("movimientos concedidas=0");
  });
});
