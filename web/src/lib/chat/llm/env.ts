// Configuración del escritor LLM (Vercel AI Gateway). Función pura: recibe las variables (no lee
// `process.env`), así se prueba y no arrastra secretos a ningún bundle. Nunca lanza ni muestra
// valores: devuelve si el LLM está activo y, si no, el motivo.
//
// Variables (solo servidor; nunca con el prefijo NEXT_PUBLIC_):
// - CHAT_LLM_ENABLED: "true" para activarlo. Cualquier otro valor o ausente → desactivado.
// - AI_GATEWAY_API_KEY: clave de AI Gateway.
// - CHAT_LLM_MODEL: id del modelo; debe estar en CHAT_LLM.allowedModels.
// - CHAT_LLM_PROVIDER (opcional): fija el proveedor (providerOptions.gateway.only) para que
//   AI Gateway no cambie a otro proveedor del mismo modelo.

import { z } from "zod";
import { CHAT_LLM } from "../config";

type EnvSource = Readonly<Record<string, string | undefined>>;

export type ChatLlmConfig =
  | { enabled: true; apiKey: string; model: string; provider: string | null }
  | {
      enabled: false;
      /**
       * `off`: no se ha activado (lo normal). Los demás son errores de configuración que conviene
       * registrar (sin valores): faltan datos, modelo no permitido o clave expuesta al navegador.
       */
      reason: "off" | "missing_key" | "missing_model" | "model_not_allowed" | "invalid_provider" | "public_secret";
    };

/** Variables que jamás deben existir con el prefijo público (llegarían al navegador). */
const FORBIDDEN_PUBLIC = ["NEXT_PUBLIC_AI_GATEWAY_API_KEY", "NEXT_PUBLIC_CHAT_LLM_API_KEY"];

const ProviderSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/);

export function readChatLlmConfig(env: EnvSource): ChatLlmConfig {
  // Una clave con prefijo público es un error grave aunque el LLM esté desactivado.
  if (FORBIDDEN_PUBLIC.some((name) => (env[name] ?? "").trim() !== "")) return { enabled: false, reason: "public_secret" };
  if ((env.CHAT_LLM_ENABLED ?? "").trim().toLowerCase() !== "true") return { enabled: false, reason: "off" };

  const apiKey = (env.AI_GATEWAY_API_KEY ?? "").trim();
  if (apiKey === "") return { enabled: false, reason: "missing_key" };
  const model = (env.CHAT_LLM_MODEL ?? "").trim();
  if (model === "") return { enabled: false, reason: "missing_model" };
  if (!(CHAT_LLM.allowedModels as readonly string[]).includes(model)) return { enabled: false, reason: "model_not_allowed" };

  const rawProvider = (env.CHAT_LLM_PROVIDER ?? "").trim();
  if (rawProvider !== "" && !ProviderSchema.safeParse(rawProvider).success) return { enabled: false, reason: "invalid_provider" };

  return { enabled: true, apiKey, model, provider: rawProvider === "" ? null : rawProvider };
}
