// Doble de Redis en memoria con la MISMA semántica que los scripts Lua del limitador (`limiterScripts.ts`):
// cada `eval` se ejecuta como un bloque atómico (sin `await` dentro), con latencia de red antes y después
// para que las peticiones concurrentes se intercalen, y un reloj controlable (el `TIME` del servidor).
// La semántica real la comprueban además las pruebas contra Redis en Docker (`limiterScripts.redis.test.ts`).
import { ACQUIRE_CODES, ACQUIRE_SCRIPT, BLOCK_SCRIPT, REFUND_SCRIPT } from "../limiterScripts";
import type { LimiterRedis } from "../gatewayLimiter";

interface Entry {
  value: string;
  expiresAt: number | null;
}

export function memoryLimiterRedis(clock = { now: 1_000_000 }, { latency = true } = {}) {
  const strings = new Map<string, Entry>();
  const zsets = new Map<string, { members: Map<string, number>; expiresAt: number | null }>();
  const evals: { script: "acquire" | "block" | "refund"; keys: string[]; args: (string | number)[] }[] = [];

  const getString = (key: string) => {
    const e = strings.get(key);
    if (e && e.expiresAt !== null && clock.now >= e.expiresAt) strings.delete(key);
    return strings.get(key);
  };
  const getZset = (key: string) => {
    const z = zsets.get(key);
    if (z && z.expiresAt !== null && clock.now >= z.expiresAt) zsets.delete(key);
    return zsets.get(key);
  };
  const pttl = (key: string) => {
    const e = getString(key);
    return !e ? -2 : e.expiresAt === null ? -1 : e.expiresAt - clock.now;
  };

  function acquire(keys: string[], args: (string | number)[]): number {
    const [window, blocked, quota, grant] = keys;
    const consumer = String(args[0]);
    const now = clock.now;
    if (Number(getString(blocked)?.value ?? 0) > now) return ACQUIRE_CODES.blocked;
    const windowMs = Number(args[5]);
    const z = getZset(window);
    if (z) for (const [m, score] of z.members) if (score <= now - windowMs) z.members.delete(m);
    const members = z ? [...z.members.keys()] : [];
    if (members.length >= Number(args[3])) return ACQUIRE_CODES.globalLimited;
    const prefix = `${consumer}:`;
    if (members.filter((m) => m.startsWith(prefix)).length >= Number(args[4])) return ACQUIRE_CODES.consumerLimited;
    let result: number = ACQUIRE_CODES.allowedChat;
    if (keys.length >= 4) {
      const used = Number(getString(quota)?.value ?? 0);
      if (used >= Number(args[6])) return ACQUIRE_CODES.quotaExhausted;
      const entry = getString(quota) ?? { value: "0", expiresAt: null };
      entry.value = String(Number(entry.value) + 1);
      strings.set(quota, entry);
      if (entry.value === "1") entry.expiresAt = now + Number(args[7]);
      const ttl = pttl(quota);
      let grantTtl = Number(args[8]);
      if (ttl > 0 && ttl < grantTtl) grantTtl = ttl;
      strings.set(grant, { value: "1", expiresAt: now + grantTtl });
      result = Number(entry.value);
    }
    const zz = getZset(window) ?? { members: new Map<string, number>(), expiresAt: null };
    zz.members.set(prefix + String(args[1]), now);
    zz.expiresAt = now + windowMs;
    zsets.set(window, zz);
    return result;
  }

  function block(keys: string[], args: (string | number)[]): number {
    const untilTs = clock.now + Number(args[0]);
    const current = Number(getString(keys[0])?.value ?? 0);
    if (untilTs <= current) return 0;
    strings.set(keys[0], { value: String(untilTs), expiresAt: clock.now + Number(args[0]) });
    return 1;
  }

  function refund(keys: string[]): number {
    const [quota, grant] = keys;
    if (!getString(grant)) return 0;
    strings.delete(grant);
    const entry = getString(quota);
    const used = Number(entry?.value ?? 0);
    if (!entry || used <= 0) return 0;
    entry.value = String(used - 1);
    return 1;
  }

  const redis: LimiterRedis = {
    async eval(script, keys, args) {
      const name = script === ACQUIRE_SCRIPT ? "acquire" : script === BLOCK_SCRIPT ? "block" : script === REFUND_SCRIPT ? "refund" : null;
      if (!name) throw new Error("script desconocido");
      evals.push({ script: name, keys, args });
      if (latency) await new Promise((r) => setTimeout(r, Math.random() * 3));
      const result = name === "acquire" ? acquire(keys, args) : name === "block" ? block(keys, args) : refund(keys);
      if (latency) await new Promise((r) => setTimeout(r, Math.random() * 3));
      return result;
    },
  };

  /** Miembros vivos de la ventana (para comprobar el límite). */
  const windowMembers = (key: string) => [...(getZset(key)?.members.keys() ?? [])];
  return { redis, clock, evals, strings, windowMembers, getString };
}
