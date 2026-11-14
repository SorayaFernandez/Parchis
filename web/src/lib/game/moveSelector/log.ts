// Registro de fallos del selector estratégico: solo tipo, código HTTP y motivo fijo, más el resumen
// saneado del error (nunca la clave, el prompt ni el texto del modelo). Como mucho una vez por minuto por
// tipo y motivo. Independiente del registro del chat.

import { MOVE_INVALID_REASONS, MoveLlmError } from "./gateway";

const LOG_INTERVAL_MS = 60_000;
const lastLogged = new Map<string, number>();

export function logMoveError(stage: string, error: unknown, now = Date.now()): void {
  let detail: string;
  let extra = "";
  if (error instanceof MoveLlmError) {
    detail = `LLM ${error.kind}${error.status ? ` (${error.status})` : ""}`;
    // Motivo del rechazo solo si es uno de los textos fijos (nunca un texto que pudiera venir de fuera).
    if (error.kind === "invalid_response") {
      detail += `: ${(MOVE_INVALID_REASONS as readonly string[]).includes(error.message) ? error.message : "motivo desconocido"}`;
    }
    if (error.detail) extra = ` ${error.detail}`;
  } else {
    detail = error instanceof Error ? error.name : "error desconocido";
  }
  const key = `${stage}:${detail}`;
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
  lastLogged.set(key, now);
  console.error(`[move-llm] ${stage}: ${detail}${extra}`);
}
