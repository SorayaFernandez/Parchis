// Registro de fallos del chat: solo etapa, tipo y código (nunca datos de la partida ni claves),
// y como mucho una vez por minuto por tipo (p. ej., si aún no existen las tablas). Un error HTTP del
// LLM añade su resumen saneado, que no forma parte del tipo: no multiplica los registros.

import { SupabaseEnvError } from "@/lib/supabase/env";
import { COOLDOWN_REASONS, ChatLlmError, INVALID_RESPONSE_REASONS } from "./llm/gatewayWriter";
import { ChatStoreError } from "./store";

/** Un mismo tipo de error se registra como mucho una vez por minuto (p. ej., si faltan las tablas). */
const LOG_INTERVAL_MS = 60_000;
const lastLogged = new Map<string, number>();

/** Registra un fallo del chat: solo tipo y código, nunca datos de la partida ni claves. */
export function logChatError(stage: string, error: unknown, now = Date.now()) {
  let detail: string;
  /** Información adicional que se muestra pero no cuenta para el límite por minuto. */
  let extra = "";
  if (error instanceof ChatStoreError) detail = `${error.kind}${error.code ? ` (${error.code})` : ""}: ${error.message}`;
  else if (error instanceof SupabaseEnvError) detail = "configuración de Supabase incorrecta";
  else if (error instanceof ChatLlmError) {
    detail = `LLM ${error.kind}${error.status ? ` (${error.status})` : ""}`;
    // Motivo concreto del rechazo: solo si es uno de los textos fijos (conjunto cerrado, así que puede
    // formar parte del límite por minuto sin multiplicar los registros).
    if (error.kind === "invalid_response") {
      detail += `: ${(INVALID_RESPONSE_REASONS as readonly string[]).includes(error.message) ? error.message : "motivo desconocido"}`;
    }
    // Motivo del `cooldown` (corte local o denegación del limitador global): solo textos fijos.
    if (error.kind === "cooldown") {
      detail += `: ${(Object.values(COOLDOWN_REASONS) as string[]).includes(error.message) ? error.message : "motivo desconocido"}`;
    }
    if (error.detail) extra = ` ${error.detail}`;
  } else detail = error instanceof Error ? error.name : "error desconocido";
  const key = `${stage}:${detail}`;
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
  lastLogged.set(key, now);
  console.error(`[chat] ${stage}: ${detail}${extra}`);
}
