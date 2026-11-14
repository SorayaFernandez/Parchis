// Cupo de consultas al selector estratégico por partida (fase 8.3): como mucho 20 llamadas al LLM por
// partida. Desde la corrección de los 429 de Nemotron, el cupo vive en el limitador global compartido con
// el chat (`src/lib/llm/`): el permiso global (4 por minuto entre chat y movimientos, 2 para movimientos),
// el bloqueo tras un 429 y el cupo de la partida se comprueban y se consumen en UNA operación atómica
// (`ACQUIRE_SCRIPT`), así que una petición denegada por el límite global no gasta cupo de la partida.
// Sustituye al script propio de F4 (`QUOTA_SCRIPT`), que comprobaba el cupo por separado.
//
// Falla cerrado: sin limitador (sin Upstash) la ruta no crea el selector y, si Redis falla, el resultado
// es `unavailable` y se usa la estrategia local.

import type { GatewayLimiter } from "@/lib/llm/gatewayLimiter";
import { LLM_GATEWAY_LIMITS } from "@/lib/llm/limiterScripts";

export const MOVES_LLM_QUOTA = {
  /** Consultas al LLM por partida. */
  limit: LLM_GATEWAY_LIMITS.movesPerGame,
  /** Caducidad del contador desde la primera consulta (7 días). */
  ttlMs: LLM_GATEWAY_LIMITS.movesQuotaTtlMs,
  /** Más tiempo que esto sin respuesta de Redis se trata como no disponible. */
  timeoutMs: LLM_GATEWAY_LIMITS.redisTimeoutMs,
} as const;

export type QuotaResult =
  /**
   * Concedida: es la consulta número `used` (1…20) de la partida, y ya cuenta en la ventana global.
   * `refund` la devuelve (como mucho una vez) si el proveedor responde 429.
   */
  | { kind: "allowed"; used: number; refund?: () => Promise<boolean> }
  /** Ya se han hecho las 20: estrategia local sin consultar. */
  | { kind: "exhausted" }
  /**
   * Sin permiso del limitador global: `global` (4 entre chat y movimientos en 60 s), `consumer` (2 de
   * movimientos en 60 s) o `blocked` (bloqueo tras un 429). Estrategia local sin consultar.
   */
  | { kind: "rate_limited"; reason: "global" | "consumer" | "blocked" }
  /** Redis no responde, falla o responde algo inesperado: estrategia local (no se asume que haya cupo). */
  | { kind: "unavailable" };

export interface MoveQuota {
  /** Intenta conseguir permiso para UNA consulta de la partida. Nunca lanza. */
  tryConsume(gameId: string): Promise<QuotaResult>;
}

/** Cupo de movimientos sobre el limitador global (lo usa la ruta de avance). */
export function createLimitedMoveQuota(limiter: GatewayLimiter): MoveQuota {
  return {
    async tryConsume(gameId) {
      const result = await limiter.acquire({ consumer: "moves", gameId });
      switch (result.kind) {
        case "allowed":
          if (!result.grant) return { kind: "unavailable" };
          {
            const grant = result.grant;
            return { kind: "allowed", used: grant.used, refund: () => limiter.refundMovesGrant(grant) };
          }
        case "quota_exhausted":
          return { kind: "exhausted" };
        case "blocked":
          return { kind: "rate_limited", reason: "blocked" };
        case "rate_limited":
          return { kind: "rate_limited", reason: result.scope };
        default:
          return { kind: "unavailable" };
      }
    },
  };
}
