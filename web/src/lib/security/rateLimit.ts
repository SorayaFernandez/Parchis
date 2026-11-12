// Límites de peticiones distribuidos (Upstash Redis + @upstash/ratelimit).
// Vercel ejecuta varias instancias a la vez: un contador en memoria no protegería nada, por eso
// los contadores viven en Redis. Sin credenciales de Upstash el limitador queda DESACTIVADO
// (desarrollo local, o producción sin configurar: se avisa en el registro, no se finge protección).

import "server-only";

import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { NO_STORE } from "@/lib/http/responses";

export type RuleName = "create" | "advanceGame" | "advanceIp" | "read";

export interface RateLimitRule {
  name: RuleName;
  /** Peticiones permitidas en la ventana. */
  limit: number;
  /** Ventana deslizante, en segundos. */
  windowSec: number;
  /**
   * Si Upstash no responde: "closed" rechaza (503), "open" deja pasar.
   * Crear partidas escribe en la BD y es fácil de abusar → cerrado. Avanzar y leer → abierto, para no
   * congelar las partidas de todos los espectadores por un fallo del proveedor (el servidor sigue
   * limitando a un avance por versión con la reserva y el control de versión).
   */
  failMode: "open" | "closed";
}

/** Límites por defecto (ver CLAUDE.md). Se pueden cambiar con RATE_LIMIT_<REGLA>="<n>/<segundos>". */
export const DEFAULT_RULES: Readonly<Record<RuleName, RateLimitRule>> = {
  /** POST /api/games, por IP. Un espectador crea partidas muy de vez en cuando. */
  create: { name: "create", limit: 5, windowSec: 600, failMode: "closed" },
  /**
   * POST /api/games/[id]/advance, por IP + partida. Cada pestaña que observa envía ~1 petición por
   * versión (≈1/s; las que pierden la carrera reciben 409). 180/min deja margen para 3 pestañas tras la
   * misma IP (NAT, varias pestañas) sin que unos espectadores bloqueen a otros.
   */
  advanceGame: { name: "advanceGame", limit: 180, windowSec: 60, failMode: "open" },
  /** POST /api/games/[id]/advance, por IP en todas las partidas (un script contra muchas partidas). */
  advanceIp: { name: "advanceIp", limit: 600, windowSec: 60, failMode: "open" },
  /** GET /api/games/[id] y la página /partida/[id], por IP. Se usan al abrir y al resincronizar. */
  read: { name: "read", limit: 120, windowSec: 60, failMode: "open" },
};

const ENV_NAMES: Record<RuleName, string> = {
  create: "RATE_LIMIT_CREATE",
  advanceGame: "RATE_LIMIT_ADVANCE_GAME",
  advanceIp: "RATE_LIMIT_ADVANCE_IP",
  read: "RATE_LIMIT_READ",
};

type Env = Readonly<Record<string, string | undefined>>;

/** Reglas con las sustituciones de entorno válidas ("<n>/<segundos>"); las inválidas se ignoran. */
export function loadRules(env: Env = process.env): Record<RuleName, RateLimitRule> {
  const rules = { ...DEFAULT_RULES };
  for (const name of Object.keys(ENV_NAMES) as RuleName[]) {
    const raw = env[ENV_NAMES[name]]?.trim();
    const match = raw ? /^(\d+)\s*\/\s*(\d+)$/.exec(raw) : null;
    if (raw && !match) console.warn(`[rate-limit] ${ENV_NAMES[name]} no válido (usa "<n>/<segundos>"); se usa el valor por defecto`);
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) {
      rules[name] = { ...rules[name], limit: Number(match[1]), windowSec: Number(match[2]) };
    }
  }
  return rules;
}

export type LimitResult =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSec: number }
  /** El proveedor no ha respondido (error o tiempo agotado). */
  | { kind: "unavailable" };

export interface RateLimiter {
  /** false: sin proveedor configurado (todo se permite). */
  readonly enabled: boolean;
  check(rule: RateLimitRule, key: string): Promise<LimitResult>;
}

export const disabledLimiter: RateLimiter = { enabled: false, check: async () => ({ kind: "allowed" }) };

/** Identificador en Redis: regla + hash de la clave (no se guardan IP en claro). */
export const identifierFor = (rule: RateLimitRule, key: string) =>
  `${rule.name}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** Prefijo de Production (sin cambios: conserva sus claves y contadores). */
export const PRODUCTION_PREFIX = "parchis:rl";

/**
 * Prefijo de las claves en Redis según el entorno, para que Preview, Development y local no compartan
 * contadores con Production aunque usen la misma base de Upstash:
 * Production → `parchis:rl`; Preview → `parchis:rl:preview`; Development → `parchis:rl:development`;
 * fuera de Vercel (`VERCEL` ≠ "1") → `parchis:rl:local`; `VERCEL_ENV` desconocido o ausente →
 * `parchis:rl:unknown` (nunca el de Production).
 */
export function rateLimitPrefix(env: Env): string {
  if (env.VERCEL !== "1") return `${PRODUCTION_PREFIX}:local`;
  switch (env.VERCEL_ENV) {
    case "production":
      return PRODUCTION_PREFIX;
    case "preview":
      return `${PRODUCTION_PREFIX}:preview`;
    case "development":
      return `${PRODUCTION_PREFIX}:development`;
    default:
      return `${PRODUCTION_PREFIX}:unknown`;
  }
}

/**
 * Limitador sobre Upstash. `timeoutMs`: pasado ese tiempo se considera que el proveedor no responde.
 * `prefix`: prefijo de las claves en Redis (ver `rateLimitPrefix`).
 */
export function createUpstashLimiter(
  redis: Redis,
  { timeoutMs = 1000, now = Date.now, prefix = PRODUCTION_PREFIX }: { timeoutMs?: number; now?: () => number; prefix?: string } = {},
): RateLimiter {
  const instances = new Map<string, Ratelimit>();
  const instanceFor = (rule: RateLimitRule) => {
    const id = `${rule.name}:${rule.limit}/${rule.windowSec}`;
    let instance = instances.get(id);
    if (!instance) {
      instance = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(rule.limit, `${rule.windowSec} s`),
        prefix,
        timeout: timeoutMs, // al agotarse, Upstash deja pasar con reason "timeout": se trata como fallo
        analytics: false,
      });
      instances.set(id, instance);
    }
    return instance;
  };

  return {
    enabled: true,
    async check(rule, key) {
      try {
        const result = await instanceFor(rule).limit(identifierFor(rule, key));
        if (result.reason === "timeout") return { kind: "unavailable" };
        if (result.success) return { kind: "allowed" };
        return { kind: "limited", retryAfterSec: Math.max(1, Math.ceil((result.reset - now()) / 1000)) };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}

const UpstashEnvSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  token: z.string().min(10),
});

let shared: RateLimiter | null = null;
let warnedDisabled = false;

/**
 * Limitador de la aplicación. Credenciales: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * (o KV_REST_API_URL / KV_REST_API_TOKEN, nombres que también usa la integración del Marketplace
 * de Vercel). Sin ellas, desactivado.
 */
export function getRateLimiter(env: Env = process.env): RateLimiter {
  if (shared) return shared;
  const parsed = UpstashEnvSchema.safeParse({
    url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
  });
  if (!parsed.success) {
    if (env.VERCEL === "1" && !warnedDisabled) {
      warnedDisabled = true;
      console.error("[rate-limit] DESACTIVADO: faltan o no son válidas UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
    }
    return disabledLimiter; // no se cachea: si se añaden las variables, se usará en el próximo arranque
  }
  shared = createUpstashLimiter(new Redis({ url: parsed.data.url, token: parsed.data.token }), { prefix: rateLimitPrefix(env) });
  return shared;
}

export interface LimitCheck {
  rule: RateLimitRule;
  /** Partes de la clave (p. ej. IP y partida); se combinan sin ambigüedad. */
  key: readonly string[];
}

export type Decision = { kind: "allow" } | { kind: "limited"; retryAfterSec: number } | { kind: "unavailable" };

let lastOpenWarning = 0;

/** Aplica varias comprobaciones a la vez y decide (límite superado gana sobre fallo del proveedor). */
export async function checkRateLimits(checks: readonly LimitCheck[], limiter: RateLimiter = getRateLimiter()): Promise<Decision> {
  if (!limiter.enabled || checks.length === 0) return { kind: "allow" };
  const results = await Promise.all(checks.map((c) => limiter.check(c.rule, JSON.stringify(c.key))));

  const limited = results.flatMap((r) => (r.kind === "limited" ? [r.retryAfterSec] : []));
  if (limited.length > 0) return { kind: "limited", retryAfterSec: Math.max(...limited) };

  const failed = checks.filter((_, i) => results[i].kind === "unavailable");
  if (failed.some((c) => c.rule.failMode === "closed")) {
    console.error(`[rate-limit] proveedor no disponible: se rechaza (${failed.map((c) => c.rule.name).join(", ")})`);
    return { kind: "unavailable" };
  }
  if (failed.length > 0 && Date.now() - lastOpenWarning > 60_000) {
    lastOpenWarning = Date.now();
    console.warn(`[rate-limit] proveedor no disponible: se deja pasar (${failed.map((c) => c.rule.name).join(", ")})`);
  }
  return { kind: "allow" };
}

/** Respuesta HTTP para una decisión negativa, o `null` si se permite. Sin IP ni detalles internos. */
export function rateLimitResponse(decision: Decision): Response | null {
  if (decision.kind === "limited") {
    return Response.json(
      { error: { code: "rate_limited", message: "Demasiadas peticiones. Espera un momento e inténtalo de nuevo." } },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(decision.retryAfterSec) } },
    );
  }
  if (decision.kind === "unavailable") {
    return Response.json(
      { error: { code: "temporarily_unavailable", message: "Servicio temporalmente no disponible. Inténtalo más tarde." } },
      { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
    );
  }
  return null;
}

/** Reglas activas (con sustituciones de entorno), calculadas una vez por instancia. */
let rulesCache: Record<RuleName, RateLimitRule> | null = null;
export const rules = (): Record<RuleName, RateLimitRule> => (rulesCache ??= loadRules());
