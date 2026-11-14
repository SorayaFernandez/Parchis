// Cliente de Vercel AI Gateway para el selector estratégico de movimientos (fase 8.3, F2).
// Independiente del cliente del chat: su propia configuración (`readMoveLlmConfig`), su propio corte
// temporal, su propia clase de error y su propio registro. Del chat solo reutiliza funciones puras y sin
// estado para sanear el registro (`redactSecrets` vía `describeHttpError`, y `describeCompletion`).
//
// Una petición por decisión, sin reintentos, con un tiempo máximo de 3 s (`MOVES_LLM.timeoutMs`) y la
// cancelación de quien llama. NUNCA lanza: devuelve la opción elegida o el fallo, para que quien llama
// use la estrategia local. La respuesta se valida con el parser estricto de F1 (`parseMoveChoice`) contra
// la decisión que se envió, así que solo puede devolver una ficha de esas opciones legales.
// No está integrado todavía en `advanceGame` (F3).

import "server-only";
import type { GameState } from "@/lib/engine";
import { describeCompletion, describeHttpError } from "@/lib/chat/llm/gatewayWriter";
import { MOVES_LLM } from "./config";
import type { MoveLlmConfig } from "./env";
import type { MoveDecision, MoveOptionId } from "./options";
import { MOVE_PARSE_REASONS, parseMoveChoice } from "./parse";
import { buildMovePrompt } from "./prompt";

export type MoveLlmErrorKind =
  /** Corte temporal activo: no se ha llamado. */
  | "cooldown"
  /** AI Gateway respondió con un código de error. */
  | "http"
  /** Sin conexión o respuesta ilegible. */
  | "network"
  /** Se agotó el tiempo máximo (3 s). */
  | "timeout"
  /** Lo canceló quien llama. */
  | "aborted"
  /** La respuesta no es una opción válida (motivo fijo de `MOVE_PARSE_REASONS`). */
  | "invalid_response";

export class MoveLlmError extends Error {
  override name = "MoveLlmError";
  constructor(
    readonly kind: MoveLlmErrorKind,
    /** Texto fijo: nunca contiene la clave, el prompt ni la respuesta. */
    message: string,
    readonly status?: number,
    /** Resumen saneado (`describeHttpError` o `describeCompletion`), sin el texto del modelo. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Motivos de `invalid_response`: los del parser y la respuesta que no se puede leer como JSON. */
export const MOVE_INVALID_REASONS = [...MOVE_PARSE_REASONS, "respuesta ilegible"] as const;

/** Corte temporal del selector, en memoria del proceso. No es el del chat. */
export interface MoveBreaker {
  blockedUntil: number;
}
export const createMoveBreaker = (): MoveBreaker => ({ blockedUntil: 0 });

export type MoveSelection =
  | { ok: true; id: MoveOptionId; pieceIndex: number }
  | { ok: false; error: MoveLlmError };

export interface MoveSelectorDeps {
  config: Extract<MoveLlmConfig, { enabled: true }>;
  fetch: typeof fetch;
  breaker: MoveBreaker;
  now?: () => number;
  /** Tiempo máximo (ms); nunca más de `MOVES_LLM.timeoutMs` (3 s). Por defecto, 3 s. */
  timeoutMs?: number;
  /** Aviso de cada fallo, para el registro (`logMoveError`). */
  onFailure?: (error: MoveLlmError) => void;
  /**
   * Tras un 429 del proveedor, con la duración del corte (`Retry-After` acotado, o 60 s): activa el bloqueo
   * global compartido con el chat (limitador de `src/lib/llm/`). No reintenta.
   */
  onRateLimited?: (durationMs: number) => void | Promise<void>;
}

export interface MoveSelector {
  /** Opción elegida por el modelo para `decision` (de `state`), o el fallo. Nunca lanza. */
  select(state: GameState, decision: MoveDecision, options?: { signal?: AbortSignal }): Promise<MoveSelection>;
  /**
   * `false` si ahora mismo no se llamaría al modelo (corte temporal local activo). Lo usa quien llama para no
   * consumir cupo (F4) en una consulta que no se va a hacer. Opcional: sin él, se asume disponible.
   */
  isAvailable?(): boolean;
}

/** `Retry-After` en segundos (entero) → ms, acotado; `null` si falta o no es válido. */
function retryAfterMs(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const ms = Number(value.trim()) * 1000;
  return ms >= 1000 ? Math.min(ms, MOVES_LLM.maxRetryAfterMs) : null;
}

function cooldownFor(status: number, retryAfter: string | null): number {
  if (status === 429) return retryAfterMs(retryAfter) ?? MOVES_LLM.rateLimitCooldownMs;
  if ([401, 402, 403, 404].includes(status)) return MOVES_LLM.configErrorCooldownMs;
  if (status >= 500) return MOVES_LLM.serverErrorCooldownMs;
  return 0; // 400 u otros: error de esta petición, sin corte
}

export function createMoveSelector(deps: MoveSelectorDeps): MoveSelector {
  const now = deps.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? MOVES_LLM.timeoutMs, MOVES_LLM.timeoutMs));

  return {
    isAvailable: () => now() >= deps.breaker.blockedUntil,
    async select(state, decision, options = {}) {
      const fail = (error: MoveLlmError): MoveSelection => {
        deps.onFailure?.(error);
        return { ok: false, error };
      };

      if (now() < deps.breaker.blockedUntil) return fail(new MoveLlmError("cooldown", "corte temporal activo"));
      if (options.signal?.aborted) return fail(new MoveLlmError("aborted", "cancelada por quien llama"));

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      /** Motivo de un aborto: el tiempo máximo o la cancelación de quien llama. */
      const abortError = () =>
        options.signal?.aborted ? new MoveLlmError("aborted", "cancelada por quien llama") : new MoveLlmError("timeout", "tiempo máximo agotado");

      const body = {
        model: deps.config.model,
        messages: buildMovePrompt(state, decision),
        max_tokens: MOVES_LLM.maxTokens,
        temperature: MOVES_LLM.temperature,
        stream: false,
        // Sin razonamiento (Nemotron gastaba los tokens razonando y devolvía `content` vacío; ver el chat).
        reasoning_effort: "none",
        // Sin `models`: AI Gateway no cambia a otro modelo. Con proveedor fijado, tampoco de proveedor.
        ...(deps.config.provider ? { providerOptions: { gateway: { only: [deps.config.provider] } } } : {}),
      };

      let response: Response;
      try {
        response = await deps.fetch(MOVES_LLM.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${deps.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
          cache: "no-store",
        });
      } catch {
        return fail(signal.aborted ? abortError() : new MoveLlmError("network", "sin conexión con AI Gateway"));
      }

      if (!response.ok) {
        const cooldown = cooldownFor(response.status, response.headers.get("Retry-After"));
        if (cooldown > 0) deps.breaker.blockedUntil = Math.max(deps.breaker.blockedUntil, now() + cooldown);
        if (response.status === 429) await Promise.resolve(deps.onRateLimited?.(cooldown)).catch(() => {});
        const detail = await describeHttpError(response, deps.config.apiKey).catch(() => "cuerpo=ilegible");
        return fail(new MoveLlmError("http", `AI Gateway respondió ${response.status}`, response.status, detail));
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (signal.aborted) return fail(abortError());
        return fail(new MoveLlmError("invalid_response", "respuesta ilegible"));
      }
      // Una respuesta que llega después de agotar el tiempo o de cancelar no se usa.
      if (signal.aborted) return fail(abortError());

      const choice = (payload as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null)?.choices?.[0];
      const parsed = parseMoveChoice({ content: choice?.message?.content, finishReason: choice?.finish_reason }, decision);
      if (!parsed.ok) return fail(new MoveLlmError("invalid_response", parsed.reason, undefined, describeCompletion(payload)));
      return { ok: true, id: parsed.id, pieceIndex: parsed.pieceIndex };
    },
  };
}
