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
  /** Ventana de 60 s llena: `global` (4 entre los dos) o `consumer` (2 de este consumidor). */
  | { kind: "rate_limited"; scope: "global" | "consumer" }
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
  /** Registro (por defecto, `console.error`). Solo textos fijos y recuentos. */
  log?: (line: string) => void;
  /** Cada cuánto, como mucho, se escribe el resumen de concesiones y denegaciones (por defecto, 60 s). */
  summaryIntervalMs?: number;
}

/** Resultado de una petición de permiso, para el resumen agregado (textos fijos). */
type Outcome = "concedidas" | "límite-global" | "límite-consumidor" | "bloqueo" | "cupo-agotado" | "no-disponible";
const OUTCOMES: readonly Outcome[] = ["concedidas", "límite-global", "límite-consumidor", "bloqueo", "cupo-agotado", "no-disponible"];
const CONSUMER_LABEL: Readonly<Record<LlmConsumer, string>> = { chat: "chat", moves: "movimientos" };

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
    log: options.log ?? ((line: string) => console.error(line)),
    summaryIntervalMs: options.summaryIntervalMs ?? 60_000,
  };

  // Resumen agregado EN MEMORIA de este proceso (sin llamadas a Redis ni contadores persistentes): cuántas
  // peticiones de permiso se han concedido o denegado, por consumidor y motivo, y qué reloj ha usado el
  // script. Se escribe como mucho una vez por intervalo, desde el propio `acquire` (sin temporizadores).
  // Solo recuentos: ni partidas, ni IP, ni prompts, ni mensajes.
  const counts = new Map<string, number>();
  const clocks = { redis: 0, cliente: 0 };
  let periodStart = o.now();
  let lastClientClockWarning = Number.NEGATIVE_INFINITY;

  function record(consumer: LlmConsumer, outcome: Outcome) {
    const key = `${consumer}:${outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const now = o.now();
    if (now - periodStart < o.summaryIntervalMs) return;
    const part = (c: LlmConsumer) => `${CONSUMER_LABEL[c]} ${OUTCOMES.map((x) => `${x}=${counts.get(`${c}:${x}`) ?? 0}`).join(" ")}`;
    o.log(`[llm-limiter] resumen de este proceso (${Math.round((now - periodStart) / 1000)} s): ${part("chat")} | ${part("moves")} | reloj redis=${clocks.redis} cliente=${clocks.cliente}`);
    counts.clear();
    clocks.redis = 0;
    clocks.cliente = 0;
    periodStart = now;
  }

  /** El script dice qué reloj ha usado; si no es el de Redis, se avisa (una vez por minuto como mucho). */
  function noteClock(clock: number) {
    if (clock === 1) {
      clocks.redis++;
      return;
    }
    clocks.cliente++;
    const now = o.now();
    if (now - lastClientClockWarning >= 60_000) {
      lastClientClockWarning = now;
      o.log("[llm-limiter] aviso: TIME de Redis no disponible en el script; se usa la hora del cliente");
    }
  }

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
      const done = (result: AcquireResult): AcquireResult => {
        record(consumer, outcomeOf(result));
        return result;
      };
      if (request.consumer === "moves") {
        // Un id que no es UUID no tiene cupo (no debería ocurrir: se llama tras reservar la partida).
        if (!GameIdSchema.safeParse(request.gameId).success) return done({ kind: "unavailable" });
        keys = [...keys, LIMITER_KEYS.movesQuota(request.gameId), LIMITER_KEYS.movesGrant(grantId)];
      }
      // El script responde `{código, reloj}` (reloj: 1 = TIME de Redis, 0 = hora del cliente).
      const reply = await run(ACQUIRE_SCRIPT, keys, args);
      if (!Array.isArray(reply) || reply.length !== 2 || !reply.every((x) => typeof x === "number" && Number.isInteger(x))) {
        return done({ kind: "unavailable" });
      }
      const [code, clock] = reply as [number, number];
      if (clock !== 0 && clock !== 1) return done({ kind: "unavailable" });
      noteClock(clock);
      switch (code) {
        case ACQUIRE_CODES.blocked:
          return done({ kind: "blocked" });
        case ACQUIRE_CODES.globalLimited:
          return done({ kind: "rate_limited", scope: "global" });
        case ACQUIRE_CODES.consumerLimited:
          return done({ kind: "rate_limited", scope: "consumer" });
        case ACQUIRE_CODES.quotaExhausted:
          return done(request.consumer === "moves" ? { kind: "quota_exhausted" } : { kind: "unavailable" });
      }
      if (request.consumer === "chat") return done(code === ACQUIRE_CODES.allowedChat ? { kind: "allowed", grant: null } : { kind: "unavailable" });
      if (code >= 1 && code <= o.movesPerGame) return done({ kind: "allowed", grant: { gameId: request.gameId, grantId, used: code } });
      return done({ kind: "unavailable" });
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

function outcomeOf(result: AcquireResult): Outcome {
  switch (result.kind) {
    case "allowed":
      return "concedidas";
    case "rate_limited":
      return result.scope === "global" ? "límite-global" : "límite-consumidor";
    case "blocked":
      return "bloqueo";
    case "quota_exhausted":
      return "cupo-agotado";
    case "unavailable":
      return "no-disponible";
  }
}

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
