// Configuración del selector estratégico con LLM. Función pura: recibe las variables (no lee
// `process.env`), nunca lanza ni muestra valores. Independiente de la del chat (`readChatLlmConfig`):
// activar o desactivar uno no afecta al otro.
//
// Variables (solo servidor; nunca con el prefijo NEXT_PUBLIC_):
// - MOVES_LLM_ENABLED: "true" para activarlo. Cualquier otro valor o ausente → desactivado.
// - AI_GATEWAY_API_KEY: clave de AI Gateway (la misma que el chat).
// - MOVES_LLM_MODEL: debe ser exactamente `MOVES_LLM.model`.
// - MOVES_LLM_PROVIDER (opcional): fija el proveedor (providerOptions.gateway.only).
//
// **Solo en Vercel Preview** (`VERCEL=1` y `VERCEL_ENV=preview`, comparación exacta). En Production,
// Development, cualquier otro valor, sin `VERCEL_ENV` o fuera de Vercel (desarrollo local), queda
// desactivado: falla cerrado. A diferencia del chat, no se activa fuera de Vercel.

import { MOVES_LLM } from "./config";

type EnvSource = Readonly<Record<string, string | undefined>>;

export type MoveLlmConfig =
  | { enabled: true; apiKey: string; model: string; provider: string | null }
  | {
      enabled: false;
      /** `off`: no se ha activado (lo normal). Los demás son errores de configuración (se registran sin valores). */
      reason: "off" | "not_preview" | "missing_key" | "missing_model" | "model_not_allowed" | "invalid_provider" | "public_secret";
    };

/** Variables que jamás deben existir con el prefijo público (llegarían al navegador). */
const FORBIDDEN_PUBLIC = ["NEXT_PUBLIC_AI_GATEWAY_API_KEY", "NEXT_PUBLIC_MOVES_LLM_API_KEY"];

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function readMoveLlmConfig(env: EnvSource): MoveLlmConfig {
  if (FORBIDDEN_PUBLIC.some((name) => (env[name] ?? "").trim() !== "")) return { enabled: false, reason: "public_secret" };
  if ((env.MOVES_LLM_ENABLED ?? "").trim().toLowerCase() !== "true") return { enabled: false, reason: "off" };
  // Solo Preview, y solo en Vercel. Cualquier otra cosa (incluido el desarrollo local) queda desactivada.
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview") return { enabled: false, reason: "not_preview" };

  const apiKey = (env.AI_GATEWAY_API_KEY ?? "").trim();
  if (apiKey === "") return { enabled: false, reason: "missing_key" };
  const model = (env.MOVES_LLM_MODEL ?? "").trim();
  if (model === "") return { enabled: false, reason: "missing_model" };
  if (model !== MOVES_LLM.model) return { enabled: false, reason: "model_not_allowed" };

  const provider = (env.MOVES_LLM_PROVIDER ?? "").trim();
  if (provider !== "" && !PROVIDER.test(provider)) return { enabled: false, reason: "invalid_provider" };

  return { enabled: true, apiKey, model, provider: provider === "" ? null : provider };
}
