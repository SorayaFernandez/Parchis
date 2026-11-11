// Escritor LLM vía Vercel AI Gateway (API compatible con OpenAI, `fetch` nativo, sin SDK).
// - Solo escribe texto de chat: no decide nada del juego.
// - Una petición por intervención: sin reintentos, sin streaming, con `max_tokens` bajo.
// - Respeta la `signal` y el `timeoutMs` que recibe (el servicio ya aplica su propio tiempo máximo).
// - Cualquier problema LANZA un `ChatLlmError`: el servicio usa entonces el escritor local, una vez.
// - Corte temporal (en memoria del proceso) ante errores de configuración o cuota (401/402/403/404),
//   429 (con `Retry-After`) y 5xx: mientras dura, falla al instante sin llamar.
// Nunca registra la clave, el prompt ni la respuesta.

import { CHARACTER_NAMES } from "@/lib/game/characters";
import { CHAT_LIMITS, CHAT_LLM } from "../config";
import { validateChatText, type ChatWriteRequest, type ChatWriter, type WrittenText } from "../writer";
import type { ChatLlmConfig } from "./env";
import { buildChatPrompt } from "./prompt";

export type ChatLlmErrorKind =
  /** Corte temporal activo: no se ha llamado. */
  | "cooldown"
  /** Respuesta HTTP no 2xx (ver `status`). */
  | "http"
  /** Red caída o respuesta ilegible. */
  | "network"
  /** Cancelada por la `signal` o por `timeoutMs`. */
  | "aborted"
  /** Respuesta sin texto o con un texto que no se puede publicar. */
  | "invalid_response";

export class ChatLlmError extends Error {
  override name = "ChatLlmError";
  constructor(
    readonly kind: ChatLlmErrorKind,
    /** Solo para el registro: nunca contiene la clave, el prompt ni la respuesta. */
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Corte temporal compartido por todas las llamadas del proceso. */
export interface LlmBreaker {
  /** Hasta cuándo (ms del reloj) no se llama al LLM. */
  blockedUntil: number;
}

export const createLlmBreaker = (): LlmBreaker => ({ blockedUntil: 0 });

export interface GatewayWriterDeps {
  config: Extract<ChatLlmConfig, { enabled: true }>;
  fetch: typeof fetch;
  breaker: LlmBreaker;
  now?: () => number;
  /** Aviso de fallo (solo tipo y código HTTP), para el registro. */
  onFailure?: (error: ChatLlmError) => void;
}

/** `Retry-After` en segundos (entero) → ms, acotado; `null` si falta o no es válido. */
function retryAfterMs(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const ms = Number(value.trim()) * 1000;
  return ms >= 1000 ? Math.min(ms, CHAT_LLM.maxRetryAfterMs) : null;
}

function cooldownFor(status: number, retryAfter: string | null): number {
  if (status === 429) return retryAfterMs(retryAfter) ?? CHAT_LLM.rateLimitCooldownMs;
  if ([401, 402, 403, 404].includes(status)) return CHAT_LLM.configErrorCooldownMs;
  if (status >= 500) return CHAT_LLM.serverErrorCooldownMs;
  return 0; // 400 u otros: error de esta petición, sin corte
}

const ALL_NAMES = Object.values(CHARACTER_NAMES);

/**
 * Limpia y comprueba el texto del modelo: primera línea, sin comillas envolventes ni un prefijo
 * "Nombre:"; como mucho `CHAT_LLM.maxChars`; solo puede nombrar a quien habla y a su rival; y pasa la
 * misma validación que el escritor local (repeticiones, marcado). Devuelve el texto o lanza.
 */
export function cleanLlmText(raw: unknown, request: ChatWriteRequest): string {
  if (typeof raw !== "string") throw new ChatLlmError("invalid_response", "respuesta sin texto");
  let text = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  // Prefijo "Nombre:" o "Nombre -" de cualquier personaje (el modelo a veces firma la frase).
  for (const name of ALL_NAMES) {
    const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：\\-—]\\s*`, "i");
    if (prefix.test(text)) {
      if (name !== CHARACTER_NAMES[request.utterance.speaker]) throw new ChatLlmError("invalid_response", "habla como otro personaje");
      text = text.replace(prefix, "");
    }
  }
  text = text.replace(/^["'«“”‘’]+|["'»“”‘’]+$/g, "").trim();
  if (text === "") throw new ChatLlmError("invalid_response", "texto vacío");
  if (text.length > CHAT_LLM.maxChars) throw new ChatLlmError("invalid_response", "texto demasiado largo");
  if (/https?:|www\.|[*#`@]/i.test(text)) throw new ChatLlmError("invalid_response", "formato no permitido");
  const allowed = new Set([CHARACTER_NAMES[request.utterance.speaker], request.utterance.rival ? CHARACTER_NAMES[request.utterance.rival] : ""]);
  const lower = text.toLowerCase();
  if (ALL_NAMES.some((name) => !allowed.has(name) && lower.includes(name.toLowerCase()))) {
    throw new ChatLlmError("invalid_response", "nombra a un personaje ajeno a la intervención");
  }
  const valid = validateChatText(text, request.recent);
  if (valid === null) throw new ChatLlmError("invalid_response", "texto repetido o no válido");
  return valid;
}

export function createGatewayWriter(deps: GatewayWriterDeps): ChatWriter {
  const now = deps.now ?? Date.now;
  const fail = (error: ChatLlmError): never => {
    deps.onFailure?.(error);
    throw error;
  };

  return {
    async write(request: ChatWriteRequest): Promise<WrittenText | null> {
      if (now() < deps.breaker.blockedUntil) fail(new ChatLlmError("cooldown", "corte temporal activo"));

      // Respeta la cancelación del servicio y, además, su propio `timeoutMs`.
      const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? CHAT_LIMITS.writerTimeoutMs, CHAT_LIMITS.writerTimeoutMs));
      const signals = [AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])];
      const signal = AbortSignal.any(signals);

      const body = {
        model: deps.config.model,
        messages: buildChatPrompt(request),
        max_tokens: CHAT_LLM.maxTokens,
        temperature: CHAT_LLM.temperature,
        stream: false,
        // Sin `models`: AI Gateway no cambia a otro modelo. Con proveedor fijado, tampoco de proveedor.
        ...(deps.config.provider ? { providerOptions: { gateway: { only: [deps.config.provider] } } } : {}),
      };

      let response: Response;
      try {
        response = await deps.fetch(CHAT_LLM.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${deps.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
          cache: "no-store",
        });
      } catch {
        if (signal.aborted) fail(new ChatLlmError("aborted", "cancelada o fuera de tiempo"));
        return fail(new ChatLlmError("network", "sin conexión con AI Gateway"));
      }

      if (!response.ok) {
        const cooldown = cooldownFor(response.status, response.headers.get("Retry-After"));
        if (cooldown > 0) deps.breaker.blockedUntil = Math.max(deps.breaker.blockedUntil, now() + cooldown);
        void response.body?.cancel().catch(() => {});
        fail(new ChatLlmError("http", `AI Gateway respondió ${response.status}`, response.status));
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (signal.aborted) fail(new ChatLlmError("aborted", "cancelada o fuera de tiempo"));
        return fail(new ChatLlmError("network", "respuesta ilegible"));
      }
      const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      try {
        return { text: cleanLlmText(content, request), source: "llm" };
      } catch (error) {
        return fail(error instanceof ChatLlmError ? error : new ChatLlmError("invalid_response", "respuesta no válida"));
      }
    },
  };
}

/**
 * Enruta por importancia: las intervenciones importantes (victoria, capturas y rachas) van al LLM;
 * el resto, al escritor local, sin llamar al modelo.
 */
export function createImportantOnlyWriter(llm: ChatWriter, local: ChatWriter): ChatWriter {
  return { write: (request) => (request.utterance.important ? llm.write(request) : local.write(request)) };
}
