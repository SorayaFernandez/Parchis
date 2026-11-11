// GET /api/games/[id] — devuelve una partida guardada (estado validado con Zod y versión).
// 404 si no existe o el id no es un UUID; errores genéricos en los demás casos.

import { toGameResponse } from "@/lib/game/api";
import { getGamesRepository } from "@/lib/game/repository";
import { NO_STORE, errorResponse, handleRouteError } from "@/lib/http/responses";
import { guardRead } from "@/lib/security/guards";

export async function GET(request: Request, ctx: RouteContext<"/api/games/[id]">) {
  const { id } = await ctx.params;

  // Límite suave por IP (si el proveedor falla, se deja pasar).
  const limited = await guardRead(request);
  if (limited) return limited;

  try {
    // El repositorio valida la fila con GameRowSchema y devuelve null si no existe
    // (también si el id no es un UUID, sin consultar la BD).
    const game = await getGamesRepository().get(id);
    if (!game) return errorResponse(404, "not_found", "La partida no existe.");
    return Response.json(toGameResponse(game), { headers: NO_STORE });
  } catch (error) {
    return handleRouteError("GET /api/games/[id]", error);
  }
}
