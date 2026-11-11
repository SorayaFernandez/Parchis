// Limitador en memoria SOLO para pruebas: ventana deslizante exacta (registro de marcas de tiempo)
// con reloj controlable. En producción se usa Upstash (createUpstashLimiter).

import type { LimitResult, RateLimiter, RateLimitRule } from "../rateLimit";
import { identifierFor } from "../rateLimit";

export function createFakeLimiter(clock = { now: 0 }) {
  const hits = new Map<string, number[]>();
  let failing = false;
  const limiter: RateLimiter & { setFailing(v: boolean): void } = {
    enabled: true,
    setFailing: (v) => (failing = v),
    async check(rule: RateLimitRule, key: string): Promise<LimitResult> {
      if (failing) return { kind: "unavailable" };
      const id = identifierFor(rule, key);
      const windowMs = rule.windowSec * 1000;
      const recent = (hits.get(id) ?? []).filter((t) => t > clock.now - windowMs);
      if (recent.length >= rule.limit) {
        hits.set(id, recent);
        return { kind: "limited", retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - clock.now) / 1000)) };
      }
      recent.push(clock.now);
      hits.set(id, recent);
      return { kind: "allowed" };
    },
  };
  return { limiter, clock, hits };
}
