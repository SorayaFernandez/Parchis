import { describe, expect, it, vi } from "vitest";
import { rateLimitPrefix } from "@/lib/security/rateLimit";
import { MOVES_LLM_QUOTA, QUOTA_SCRIPT, createMoveQuota, getMoveQuota, quotaKey, type QuotaRedis } from "../quota";

vi.mock("server-only", () => ({}));

const GAME_A = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const GAME_B = "3f39156e-12ec-4bd0-86af-58a5ccf8cd66";
const PREFIX = "parchis:rl:preview";

/**
 * Doble de Redis en memoria que ejecuta QUOTA_SCRIPT con la misma semántica que el Lua (GET, límite,
 * INCR y PEXPIRE en la primera) de forma atómica, como Redis, con latencia de red antes y después para
 * que las peticiones concurrentes se intercalen. Reloj controlable para la caducidad.
 */
function memoryRedis(clock = { now: 0 }) {
  const store = new Map<string, { value: number; expiresAt: number | null }>();
  const evals: { keys: string[]; args: (string | number)[] }[] = [];
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt !== null && clock.now >= entry.expiresAt) store.delete(key);
    return store.get(key);
  };
  const redis: QuotaRedis = {
    async eval(script, keys, args) {
      evals.push({ keys, args });
      if (script !== QUOTA_SCRIPT) throw new Error("script desconocido");
      await new Promise((r) => setTimeout(r, Math.random() * 3)); // ida
      // Bloque atómico (sin await): como el Lua en Redis.
      const [key] = keys;
      const limit = Number(args[0]);
      const used = live(key)?.value ?? 0;
      let result: number;
      if (used >= limit) {
        result = -1;
      } else {
        const entry = live(key) ?? { value: 0, expiresAt: null };
        entry.value += 1;
        if (entry.value === 1) entry.expiresAt = clock.now + Number(args[1]);
        store.set(key, entry);
        result = entry.value;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 3)); // vuelta
      return result;
    },
  };
  return { redis, store, evals, clock };
}

describe("QUOTA_SCRIPT", () => {
  it("comprobación e incremento en un único script atómico (GET, límite, INCR y PEXPIRE solo la primera vez)", () => {
    expect(QUOTA_SCRIPT).toContain("redis.call('GET', KEYS[1])");
    expect(QUOTA_SCRIPT).toContain("if used >= limit then return -1 end");
    expect(QUOTA_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
    expect(QUOTA_SCRIPT).toContain("if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end");
  });
});

describe("createMoveQuota", () => {
  it("de 0 a 20: cada consulta se concede con su número; la 21 y las siguientes se rechazan sin seguir contando", async () => {
    const m = memoryRedis();
    const quota = createMoveQuota(m.redis, { prefix: PREFIX });
    const results = [];
    for (let i = 0; i < 22; i++) results.push(await quota.tryConsume(GAME_A));
    expect(results.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => ({ kind: "allowed", used: i + 1 })));
    expect(results[19]).toEqual({ kind: "allowed", used: 20 });
    expect(results[20]).toEqual({ kind: "exhausted" });
    expect(results[21]).toEqual({ kind: "exhausted" });
    expect(m.store.get(quotaKey(PREFIX, GAME_A))!.value).toBe(20);
    expect(MOVES_LLM_QUOTA.limit).toBe(20);
  });

  it("una sola llamada a Redis por consulta, con la clave de la partida, el límite y la caducidad (sin datos personales)", async () => {
    const m = memoryRedis();
    await createMoveQuota(m.redis, { prefix: PREFIX }).tryConsume(GAME_A);
    expect(m.evals).toEqual([{ keys: [`${PREFIX}:moves-llm:${GAME_A}`], args: [20, MOVES_LLM_QUOTA.ttlMs] }]);
  });

  it("partidas distintas tienen contadores independientes", async () => {
    const m = memoryRedis();
    const quota = createMoveQuota(m.redis, { prefix: PREFIX });
    for (let i = 0; i < 20; i++) await quota.tryConsume(GAME_A);
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "exhausted" });
    expect(await quota.tryConsume(GAME_B)).toEqual({ kind: "allowed", used: 1 });
    expect(m.store.get(quotaKey(PREFIX, GAME_B))!.value).toBe(1);
  });

  it("los entornos no comparten contadores (prefijo del limitador)", async () => {
    const m = memoryRedis();
    for (let i = 0; i < 20; i++) await createMoveQuota(m.redis, { prefix: "parchis:rl:preview" }).tryConsume(GAME_A);
    expect(await createMoveQuota(m.redis, { prefix: "parchis:rl" }).tryConsume(GAME_A)).toEqual({ kind: "allowed", used: 1 });
    expect(rateLimitPrefix({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe("parchis:rl:preview");
  });

  it("peticiones concurrentes (30 a la vez, también desde varios clientes) no superan el cupo", async () => {
    const m = memoryRedis();
    const instances = [createMoveQuota(m.redis, { prefix: PREFIX }), createMoveQuota(m.redis, { prefix: PREFIX }), createMoveQuota(m.redis, { prefix: PREFIX })];
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => instances[i % 3].tryConsume(GAME_A)));
    const allowed = results.filter((r) => r.kind === "allowed").map((r) => (r as { used: number }).used);
    expect(allowed).toHaveLength(20);
    expect([...allowed].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results.filter((r) => r.kind === "exhausted")).toHaveLength(10);
    expect(m.store.get(quotaKey(PREFIX, GAME_A))!.value).toBe(20);
  });

  it("contador caducado: la caducidad se fija en la primera consulta y, al vencer, la partida empieza de cero", async () => {
    const m = memoryRedis({ now: 1_000 });
    const quota = createMoveQuota(m.redis, { prefix: PREFIX, ttlMs: 10_000 });
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "allowed", used: 1 });
    m.clock.now = 9_000;
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "allowed", used: 2 });
    // La segunda no renueva la caducidad: vence a los 10 s de la primera.
    expect(m.store.get(quotaKey(PREFIX, GAME_A))!.expiresAt).toBe(11_000);
    m.clock.now = 11_000;
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "allowed", used: 1 });
    // Una partida agotada cuyo contador caduca recupera el cupo.
    for (let i = 0; i < 19; i++) await quota.tryConsume(GAME_A);
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "exhausted" });
    m.clock.now += 10_000;
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "allowed", used: 1 });
  });

  it("error de Redis: unavailable (nunca se asume que hay cupo)", async () => {
    const quota = createMoveQuota({ eval: async () => { throw new Error("ECONNRESET"); } }, { prefix: PREFIX });
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "unavailable" });
    const sync = createMoveQuota({ eval: () => { throw new Error("síncrono"); } }, { prefix: PREFIX });
    expect(await sync.tryConsume(GAME_A)).toEqual({ kind: "unavailable" });
  });

  it("respuesta inesperada de Redis: unavailable", async () => {
    for (const value of ["5", 0, 21, -2, 1.5, Number.NaN, null, undefined, { used: 1 }, [1], true]) {
      const quota = createMoveQuota({ eval: async () => value }, { prefix: PREFIX });
      expect(await quota.tryConsume(GAME_A), JSON.stringify(value)).toEqual({ kind: "unavailable" });
    }
  });

  it("Redis que no responde: unavailable al agotar su tiempo", async () => {
    const quota = createMoveQuota({ eval: () => new Promise(() => {}) }, { prefix: PREFIX, timeoutMs: 20 });
    expect(await quota.tryConsume(GAME_A)).toEqual({ kind: "unavailable" });
    expect(MOVES_LLM_QUOTA.timeoutMs).toBe(1_000);
  });

  it("un id que no es UUID no toca Redis", async () => {
    const m = memoryRedis();
    expect(await createMoveQuota(m.redis, { prefix: PREFIX }).tryConsume("no-es-un-uuid")).toEqual({ kind: "unavailable" });
    expect(m.evals).toHaveLength(0);
  });
});

describe("getMoveQuota", () => {
  it("sin credenciales de Upstash (o no válidas): null", () => {
    expect(getMoveQuota({})).toBeNull();
    expect(getMoveQuota({ UPSTASH_REDIS_REST_URL: "http://inseguro.example", UPSTASH_REDIS_REST_TOKEN: "token-largo-de-prueba" })).toBeNull();
    expect(getMoveQuota({ UPSTASH_REDIS_REST_URL: "https://ejemplo.upstash.io", UPSTASH_REDIS_REST_TOKEN: "corto" })).toBeNull();
  });

  it("con credenciales (también las de la integración KV): un cupo, el mismo mientras no cambien", () => {
    const env = { UPSTASH_REDIS_REST_URL: "https://ejemplo.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token-largo-de-prueba" };
    const first = getMoveQuota(env);
    expect(typeof first?.tryConsume).toBe("function");
    expect(getMoveQuota(env)).toBe(first);
    expect(getMoveQuota({ KV_REST_API_URL: "https://otro.upstash.io", KV_REST_API_TOKEN: "otro-token-largo" })).not.toBeNull();
  });
});
