// Escritor LLM vía Vercel AI Gateway (API compatible con OpenAI, `fetch` nativo, sin SDK).
// - Solo escribe texto de chat: no decide nada del juego.
// - Una petición por intervención: sin reintentos, sin streaming, con `max_tokens` bajo.
// - Respeta la `signal` y el `timeoutMs` que recibe (el servicio ya aplica su propio tiempo máximo).
// - Cualquier problema LANZA un `ChatLlmError`: el servicio usa entonces el escritor local, una vez.
// - Corte temporal (en memoria del proceso) ante errores de configuración o cuota (401/402/403/404),
//   429 (con `Retry-After`) y 5xx: mientras dura, falla al instante sin llamar.
// Nunca registra la clave, el prompt ni la respuesta del modelo. De una respuesta HTTP de error solo
// guarda un resumen saneado (`describeHttpError`): content-type, x-vercel-id y error.type/code/message.

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
    /** Solo en `http`: resumen saneado de la respuesta de error (ver `describeHttpError`). */
    readonly detail?: string,
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

/** Bytes del cuerpo de una respuesta de error que se leen como máximo. */
const ERROR_BODY_MAX_BYTES = 2048;

/** Lee como mucho `maxBytes` del cuerpo y cancela el resto. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Oculta secretos en un texto que viene de fuera antes de registrarlo: la propia clave (si la
 * conocemos), `Bearer <algo>` y cualquier cadena con aspecto de token (24+ caracteres alfanuméricos,
 * `_` o `-`, con algún dígito o con mayúsculas y minúsculas). Además lo deja en una línea y lo recorta.
 */
export function redactSecrets(value: string, maxLength: number, apiKey?: string): string {
  let text = value;
  if (apiKey) text = text.split(apiKey).join("[oculto]");
  text = text
    .replace(/Bearer\s+\S+/gi, "Bearer [oculto]")
    // Con un dígito o con mayúsculas y minúsculas: así no se ocultan códigos como `model_not_found_for_team`.
    .replace(/[A-Za-z0-9_-]{24,}/g, (m) => (/\d/.test(m) || (/[a-z]/.test(m) && /[A-Z]/.test(m)) ? "[oculto]" : m))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Resumen saneado de una respuesta HTTP de error, para el registro: `content-type` (solo el tipo),
 * `x-vercel-id` (solo si tiene su formato) y, si el cuerpo es JSON con `error`, sus campos `type`,
 * `code` y `message`, enmascarados y recortados. Nunca el cuerpo completo (p. ej., una página HTML).
 * Nunca lanza.
 */
export async function describeHttpError(response: Response, apiKey?: string): Promise<string> {
  const parts: string[] = [];
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  parts.push(`content-type=${/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) && contentType.length <= 100 ? contentType : "?"}`);
  const vercelId = (response.headers.get("x-vercel-id") ?? "").trim();
  if (vercelId !== "") parts.push(`x-vercel-id=${/^[A-Za-z0-9:_-]{1,128}$/.test(vercelId) && vercelId.includes("::") ? vercelId : "[no válido]"}`);

  let raw: string;
  try {
    raw = await readLimited(response, ERROR_BODY_MAX_BYTES);
  } catch {
    parts.push("cuerpo=ilegible");
    return parts.join(" ");
  }
  if (raw.trim() === "") {
    parts.push("cuerpo=vacío");
    return parts.join(" ");
  }
  let error: unknown;
  try {
    error = (JSON.parse(raw) as { error?: unknown } | null)?.error;
  } catch {
    parts.push("cuerpo=no-json");
    return parts.join(" ");
  }
  if (typeof error === "string") {
    parts.push(`error.message=${redactSecrets(error, 200, apiKey)}`);
    return parts.join(" ");
  }
  if (typeof error !== "object" || error === null) {
    parts.push("cuerpo=json-sin-error");
    return parts.join(" ");
  }
  const fields = error as Record<string, unknown>;
  for (const [name, max] of [["type", 60], ["code", 60], ["message", 200]] as const) {
    const value = fields[name];
    if (typeof value === "string" || typeof value === "number") parts.push(`error.${name}=${redactSecrets(String(value), max, apiKey)}`);
  }
  return parts.join(" ");
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
        // Corte temporal ya aplicado. Se lee un resumen saneado del error (limitado) para el registro.
        const detail = await describeHttpError(response, deps.config.apiKey).catch(() => "cuerpo=ilegible");
        fail(new ChatLlmError("http", `AI Gateway respondió ${response.status}`, response.status, detail));
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
