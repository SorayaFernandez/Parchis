// Cliente del limitador global de llamadas a AI Gateway (ver `limiterScripts.ts`), sobre Upstash Redis.
// Lo comparten el chat y el selector de movimientos. Nunca lanza: ante cualquier fallo de Redis (error,
// más de 1 s o respuesta inesperada) responde `unavailable`, y quien llama NO llama al modelo (usa su
// respuesta local). Nunca reintenta.

import "server-only";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { ACQUIRE_CODES, ACQUIRE_SCRIPT, BLOCK_SCRIPT, LIMITER_KEYS, LLM_GATEWAY_LIMITS, REFUND_SCRIPT, type LlmConsumer } from "./limiterScripts";

/** Concesión de una consulta de movimientos (para poder devolverla una vez si el proveedor responde 429). */
export interface MovesGrant {
  gameId: string;
  grantId: string;
  /** Número de la consulta en la partida (1…20). */
  used: number;
}

export type AcquireResult =
  | { kind: "allowed"; grant: MovesGrant | null }
  /** Bloqueo global vigente tras un 429 del proveedor. */
  | { kind: "blocked" }
  /** Límite global o del consumidor en la ventana de 60 s. */
  | { kind: "rate_limited" }
  /** La partida ya ha hecho sus 20 consultas de movimientos. */
  | { kind: "quota_exhausted" }
  /** Redis no responde, falla o responde algo inesperado: no se llama al modelo. */
  | { kind: "unavailable" };

export interface GatewayLimiter {
  /** Pide permiso para UNA llamada al modelo, justo antes de enviarla. */
  acquire(request: { consumer: "chat" } | { consumer: "moves"; gameId: string }): Promise<AcquireResult>;
  /** Tras un 429: bloqueo global de `durationMs` (acotado), sin acortar uno más largo. Nunca lanza. */
  reportRateLimited(durationMs: number): Promise<void>;
  /** Devuelve una concesión de movimientos (solo ante un 429). Como mucho una vez. `true` si la devolvió. */
  refundMovesGrant(grant: MovesGrant): Promise<boolean>;
}

/** Lo que necesita del cliente de Redis (en las pruebas, un doble en memoria o un Redis real). */
export interface LimiterRedis {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

export interface GatewayLimiterOptions {
  timeoutMs?: number;
  windowMs?: number;
  globalLimit?: number;
  consumerLimit?: number;
  movesPerGame?: number;
  movesQuotaTtlMs?: number;
  grantTtlMs?: number;
  now?: () => number;
  newId?: () => string;
}

const GameIdSchema = z.uuid();

/** Duración del bloqueo tras un 429: el `Retry-After` dado, acotado a [1 s, 1 h]. */
export const blockDuration = (ms: number) =>
  Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(Math.round(ms), 1_000), LLM_GATEWAY_LIMITS.maxBlockMs) : LLM_GATEWAY_LIMITS.defaultBlockMs;

export function createGatewayLimiter(redis: LimiterRedis, options: GatewayLimiterOptions = {}): GatewayLimiter {
  const o = {
    timeoutMs: options.timeoutMs ?? LLM_GATEWAY_LIMITS.redisTimeoutMs,
    windowMs: options.windowMs ?? LLM_GATEWAY_LIMITS.windowMs,
    globalLimit: options.globalLimit ?? LLM_GATEWAY_LIMITS.globalLimit,
    consumerLimit: options.consumerLimit ?? LLM_GATEWAY_LIMITS.consumerLimit,
    movesPerGame: options.movesPerGame ?? LLM_GATEWAY_LIMITS.movesPerGame,
    movesQuotaTtlMs: options.movesQuotaTtlMs ?? LLM_GATEWAY_LIMITS.movesQuotaTtlMs,
    grantTtlMs: options.grantTtlMs ?? LLM_GATEWAY_LIMITS.grantTtlMs,
    now: options.now ?? Date.now,
    newId: options.newId ?? randomUUID,
  };

  /** `eval` con tiempo máximo; `undefined` si falla o no responde a tiempo. */
  async function run(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), o.timeoutMs);
      });
      const result = await Promise.race([redis.eval(script, keys, args), timeout]);
      return result === TIMEOUT ? undefined : result;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async acquire(request) {
      const consumer: LlmConsumer = request.consumer;
      const grantId = o.newId();
      const args = [consumer, grantId, o.now(), o.globalLimit, o.consumerLimit, o.windowMs, o.movesPerGame, o.movesQuotaTtlMs, o.grantTtlMs];
      let keys: string[] = [LIMITER_KEYS.window, LIMITER_KEYS.blocked];
      if (request.consumer === "moves") {
        // Un id que no es UUID no tiene cupo (no debería ocurrir: se llama tras reservar la partida).
        if (!GameIdSchema.safeParse(request.gameId).success) return { kind: "unavailable" };
        keys = [...keys, LIMITER_KEYS.movesQuota(request.gameId), LIMITER_KEYS.movesGrant(grantId)];
      }
      const code = await run(ACQUIRE_SCRIPT, keys, args);
      if (typeof code !== "number" || !Number.isInteger(code)) return { kind: "unavailable" };
      switch (code) {
        case ACQUIRE_CODES.blocked:
          return { kind: "blocked" };
        case ACQUIRE_CODES.globalLimited:
        case ACQUIRE_CODES.consumerLimited:
          return { kind: "rate_limited" };
        case ACQUIRE_CODES.quotaExhausted:
          return request.consumer === "moves" ? { kind: "quota_exhausted" } : { kind: "unavailable" };
      }
      if (request.consumer === "chat") return code === ACQUIRE_CODES.allowedChat ? { kind: "allowed", grant: null } : { kind: "unavailable" };
      if (code >= 1 && code <= o.movesPerGame) return { kind: "allowed", grant: { gameId: request.gameId, grantId, used: code } };
      return { kind: "unavailable" };
    },

    async reportRateLimited(durationMs) {
      const ms = blockDuration(durationMs);
      await run(BLOCK_SCRIPT, [LIMITER_KEYS.blocked], [ms, "", o.now()]);
    },

    async refundMovesGrant(grant) {
      if (!GameIdSchema.safeParse(grant.gameId).success) return false;
      const result = await run(REFUND_SCRIPT, [LIMITER_KEYS.movesQuota(grant.gameId), LIMITER_KEYS.movesGrant(grant.grantId)], []);
      return result === 1;
    },
  };
}

const TIMEOUT = Symbol("timeout");

const UpstashEnvSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  token: z.string().min(10),
});

let shared: { credentials: string; limiter: GatewayLimiter } | null = null;

/**
 * Limitador de la aplicación con las credenciales de Upstash del proyecto (UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN, o KV_REST_API_URL / KV_REST_API_TOKEN). Sin ellas, `null`: quien llama no usa
 * el modelo (el chat usa sus frases locales y el selector, la estrategia local). Un cliente por proceso.
 */
export function getGatewayLimiter(env: Readonly<Record<string, string | undefined>> = process.env): GatewayLimiter | null {
  const parsed = UpstashEnvSchema.safeParse({
    url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
  });
  if (!parsed.success) return null;
  const credentials = `${parsed.data.url} ${parsed.data.token}`;
  if (shared?.credentials !== credentials) {
    shared = { credentials, limiter: createGatewayLimiter(new Redis({ url: parsed.data.url, token: parsed.data.token })) };
  }
  return shared.limiter;
}
