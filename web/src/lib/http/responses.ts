// Respuestas JSON de los Route Handlers: formato de error común y traducción de errores
// internos a códigos HTTP con mensajes genéricos (sin detalles de la BD ni de la configuración).

import { GameRepositoryError } from "@/lib/game/repository";
import { SupabaseEnvError } from "@/lib/supabase/env";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface ApiError {
  error: { code: string; message: string };
}

export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status, headers: NO_STORE });
}

/**
 * Convierte un error inesperado en una respuesta segura y lo registra en el servidor
 * (tipo y código de PostgreSQL como mucho; nunca claves ni el estado).
 */
export function handleRouteError(scope: string, error: unknown): Response {
  if (error instanceof SupabaseEnvError) {
    console.error(`[${scope}] configuración de Supabase incorrecta:`, error.message);
    return errorResponse(500, "server_misconfigured", "El servidor no está configurado correctamente.");
  }
  if (error instanceof GameRepositoryError) {
    console.error(`[${scope}] ${error.kind}${error.code ? ` (${error.code})` : ""}: ${error.message}`);
    if (error.kind === "database") {
      return errorResponse(503, "storage_unavailable", "No se ha podido acceder a las partidas. Inténtalo de nuevo.");
    }
    return errorResponse(500, "internal_error", "La partida guardada no se puede leer.");
  }
  console.error(`[${scope}] error inesperado:`, error instanceof Error ? error.message : error);
  return errorResponse(500, "internal_error", "Error inesperado.");
}
