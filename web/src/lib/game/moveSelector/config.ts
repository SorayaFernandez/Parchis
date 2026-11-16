// Configuración fija del selector estratégico con LLM (fase 8.3). Independiente de la del chat
// (`CHAT_LLM`): mismo endpoint de AI Gateway, pero sus propios límites, su propio corte temporal y sus
// propias variables de entorno. Sin modelos alternativos ni de pago.

export const MOVES_LLM = {
  /** API compatible con OpenAI de Vercel AI Gateway (la misma que usa el chat). */
  endpoint: "https://ai-gateway.vercel.sh/v1/chat/completions",
  /** El único modelo permitido, con su identificador exacto. */
  model: "nvidia/nemotron-3.5-lightning-free",
  /** Tiempo máximo de cada llamada (ms). Sin reintentos. */
  timeoutMs: 3_000,
  /** `{"choice":"A"}` cabe de sobra; sin razonamiento (`reasoning_effort: "none"`). */
  maxTokens: 20,
  /** Baja: se pide elegir una opción, no escribir. */
  temperature: 0.3,
  /** Corte temporal ante errores de configuración, autenticación, cuota o modelo (401, 402, 403, 404). */
  configErrorCooldownMs: 10 * 60_000,
  /** 429 sin `Retry-After` válido. */
  rateLimitCooldownMs: 60_000,
  /** Máximo que se respeta de un `Retry-After`. */
  maxRetryAfterMs: 60 * 60_000,
  /** 5xx. */
  serverErrorCooldownMs: 30_000,
} as const;
