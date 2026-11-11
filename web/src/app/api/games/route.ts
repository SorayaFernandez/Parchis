// POST /api/games — crea una partida con los cuatro personajes IA y la guarda en Supabase.
// Respuesta 201: { id, version }. No requiere datos de entrada (cuerpo vacío o `{}`).

import { z } from "zod";
import { createGame } from "@/lib/engine";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { getGamesRepository } from "@/lib/game/repository";
import { NO_STORE, errorResponse, handleRouteError } from "@/lib/http/responses";
import { guardCreate } from "@/lib/security/guards";

/** Cuerpo vacío o un objeto vacío. Cualquier otra cosa se rechaza (400). */
async function hasValidBody(request: Request): Promise<boolean> {
  const text = (await request.text()).trim();
  if (text === "") return true;
  try {
    return z.strictObject({}).safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  // Límite por IP antes de cualquier trabajo (429 con Retry-After; 503 si el proveedor no responde).
  const limited = await guardCreate(request);
  if (limited) return limited;

  if (!(await hasValidBody(request))) {
    return errorResponse(400, "invalid_body", "Esta petición no admite parámetros: envía un cuerpo vacío o {}.");
  }

  try {
    const game = await getGamesRepository().create(createGame([...CHARACTER_IDS]));
    return Response.json({ id: game.id, version: game.version }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleRouteError("POST /api/games", error);
  }
}
