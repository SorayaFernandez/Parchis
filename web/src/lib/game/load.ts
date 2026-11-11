// Carga de una partida en el servidor para la página /partida/[id].
// Lee con el repositorio (cliente de servidor), valida con Zod y traduce los errores a
// mensajes seguros para el usuario. Nunca lanza: la página siempre puede mostrar algo.

import "server-only";

import { SupabaseEnvError } from "@/lib/supabase/env";
import { GameResponseSchema, toGameResponse, type LoadGameResult } from "./api";
import { GameRepositoryError, getGamesRepository, type GamesRepository } from "./repository";

export async function loadGame(id: string, repository?: GamesRepository): Promise<LoadGameResult> {
  try {
    // El repositorio valida la fila con GameRowSchema y devuelve null si no existe
    // (también si el id no es un UUID, sin consultar la BD).
    const game = await (repository ?? getGamesRepository()).get(id);
    if (!game) return { kind: "not_found" };
    // Se valida también el contrato que llega a los componentes.
    return { kind: "ok", game: GameResponseSchema.parse(toGameResponse(game)) };
  } catch (error) {
    if (error instanceof SupabaseEnvError) {
      console.error("[/partida/[id]] configuración de Supabase incorrecta:", error.message);
      return { kind: "error", message: "El servidor no está configurado correctamente." };
    }
    if (error instanceof GameRepositoryError) {
      console.error(`[/partida/[id]] ${error.kind}${error.code ? ` (${error.code})` : ""}: ${error.message}`);
      return {
        kind: "error",
        message:
          error.kind === "database"
            ? "El almacenamiento de partidas no está disponible ahora mismo."
            : "La partida guardada no se puede leer.",
      };
    }
    console.error("[/partida/[id]] error inesperado:", error instanceof Error ? error.message : error);
    return { kind: "error", message: "No se ha podido recuperar la partida." };
  }
}
