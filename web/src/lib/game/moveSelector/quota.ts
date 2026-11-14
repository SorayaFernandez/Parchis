// Cupo de consultas al selector estratégico por partida (fase 8.3, F4): como mucho 20 llamadas al LLM
// por partida, con un contador persistente en Upstash Redis compartido por todas las instancias.
//
// Atomicidad: la comprobación y el incremento van en un único script Lua (`EVAL`), que Redis ejecuta de
// forma atómica: lee el contador, rechaza si ya está en el límite y, si no, lo incrementa (y en la primera
// llamada le pone la caducidad). Dos peticiones simultáneas no pueden pasar las dos del 19 al 20.
//
// En Redis solo se guarda un número por partida, con la clave `<prefijo del entorno>:moves-llm:<id>`
// (el id es el UUID de la partida; nada de usuarios, IP ni prompts). El prefijo es el del limitador
// (`rateLimitPrefix`), así que Preview y Production no comparten contadores.
//
// Falla cerrado: sin credenciales no hay cupo (la ruta no crea el selector) y, si Redis falla, tarda más
// de 1 s o responde algo inesperado, el resultado es `unavailable` y se usa la estrategia local.

import "server-only";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { rateLimitPrefix } from "@/lib/security/rateLimit";

export const MOVES_LLM_QUOTA = {
  /** Consultas al LLM por partida. */
  limit: 20,
  /**
   * Caducidad del contador desde la primera consulta (7 días): una partida normal dura minutos, así que
   * el contador cubre toda la partida; una partida abandonada no deja la clave para siempre. Si una
   * partida siguiera viva más de 7 días, recibiría otras 20 como mucho.
   */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** Más tiempo que esto sin respuesta de Redis se trata como no disponible. */
  timeoutMs: 1_000,
} as const;

/** Lua: atómico en Redis. Devuelve el número de la consulta concedida (1…limit) o -1 si ya no hay cupo. */
export const QUOTA_SCRIPT = `
local limit = tonumber(ARGV[1])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= limit then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return used
`;

export type QuotaResult =
  /** Concedida: es la consulta número `used` (1…20) de la partida. */
  | { kind: "allowed"; used: number }
  /** Ya se han hecho las 20: estrategia local sin consultar. */
  | { kind: "exhausted" }
  /** Redis no responde, falla o responde algo inesperado: estrategia local (no se asume que haya cupo). */
  | { kind: "unavailable" };

export interface MoveQuota {
  /** Intenta consumir una consulta de la partida. Nunca lanza. */
  tryConsume(gameId: string): Promise<QuotaResult>;
}

/** Lo que necesita del cliente de Redis (en las pruebas, un doble en memoria). */
export interface QuotaRedis {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

const GameIdSchema = z.uuid();

export const quotaKey = (prefix: string, gameId: string) => `${prefix}:moves-llm:${gameId}`;

export function createMoveQuota(redis: QuotaRedis, options: { prefix: string; timeoutMs?: number; limit?: number; ttlMs?: number }): MoveQuota {
  const limit = options.limit ?? MOVES_LLM_QUOTA.limit;
  const ttlMs = options.ttlMs ?? MOVES_LLM_QUOTA.ttlMs;
  const timeoutMs = options.timeoutMs ?? MOVES_LLM_QUOTA.timeoutMs;

  return {
    async tryConsume(gameId) {
      // Un id que no es UUID no tiene contador (no debería ocurrir: se llama tras reservar la partida).
      if (!GameIdSchema.safeParse(gameId).success) return { kind: "unavailable" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const result = await Promise.race([redis.eval(QUOTA_SCRIPT, [quotaKey(options.prefix, gameId)], [limit, ttlMs]), timeout]);
        if (result === "timeout") return { kind: "unavailable" };
        if (result === -1) return { kind: "exhausted" };
        if (typeof result === "number" && Number.isInteger(result) && result >= 1 && result <= limit) return { kind: "allowed", used: result };
        return { kind: "unavailable" };
      } catch {
        return { kind: "unavailable" };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

const UpstashEnvSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  token: z.string().min(10),
});

/**
 * Cupo de la aplicación con las mismas credenciales que el limitador (UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN, o KV_REST_API_URL / KV_REST_API_TOKEN). Sin ellas, `null`: no hay cupo
 * verificable y el selector no se usa.
 */
let shared: { credentials: string; quota: MoveQuota } | null = null;

export function getMoveQuota(env: Readonly<Record<string, string | undefined>> = process.env): MoveQuota | null {
  const parsed = UpstashEnvSchema.safeParse({
    url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
  });
  if (!parsed.success) return null;
  // Un cliente por proceso (mientras no cambien las credenciales ni el entorno).
  const credentials = `${parsed.data.url} ${parsed.data.token} ${rateLimitPrefix(env)}`;
  if (shared?.credentials !== credentials) {
    shared = { credentials, quota: createMoveQuota(new Redis({ url: parsed.data.url, token: parsed.data.token }), { prefix: rateLimitPrefix(env) }) };
  }
  return shared.quota;
}
