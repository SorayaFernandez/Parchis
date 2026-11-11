// POST /api/games/[id]/advance — aplica UNA acción (tirar o mover) del personaje en turno.
// Cuerpo: { "expectedVersion": <versión que tiene el cliente> }.
// 200: { id, version, status, winner, action, events, state }. El dado se genera aquí, en el servidor.
// 409 (sin cambios en la partida): version_conflict | turn_in_progress | game_finished | lease_expired.

import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { EngineRejectedActionError, advanceGame } from "@/lib/game/advance";
import { getGamesRepository } from "@/lib/game/repository";
import { NO_STORE, errorResponse, handleRouteError } from "@/lib/http/responses";
import { guardAdvance } from "@/lib/security/guards";

const BodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

async function readBody(request: Request) {
  try {
    return BodySchema.safeParse(JSON.parse(await request.text()));
  } catch {
    return null;
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/games/[id]/advance">) {
  const { id } = await ctx.params;

  // Límites por IP + partida y por IP (si el proveedor falla, se deja pasar: el servidor ya limita a
  // un avance por versión). Va antes de leer el cuerpo y de tocar la BD.
  const limited = await guardAdvance(request, id);
  if (limited) return limited;

  const body = await readBody(request);
  if (!body?.success) {
    return errorResponse(400, "invalid_body", 'Envía { "expectedVersion": <número entero ≥ 1> }.');
  }

  try {
    const result = await advanceGame(id, body.data.expectedVersion, {
      repository: getGamesRepository(),
      rollDie: () => randomInt(1, 7), // 1..6, solo en el servidor
      newToken: () => randomUUID(),
    });

    switch (result.kind) {
      case "advanced": {
        const { game, action, events } = result;
        return Response.json(
          { id: game.id, version: game.version, status: game.status, winner: game.winner, action, events, state: game.state },
          { headers: NO_STORE },
        );
      }
      case "not_found":
        return errorResponse(404, "not_found", "La partida no existe.");
      case "game_finished":
        return conflict("game_finished", "La partida ha terminado.", result.version);
      case "version_conflict":
        return conflict("version_conflict", "La partida ya no está en esa versión.", result.currentVersion);
      case "turn_in_progress":
        return conflict("turn_in_progress", "Otro proceso está resolviendo este turno.");
      case "lease_expired":
        return conflict("lease_expired", "La reserva del turno caducó; no se ha guardado nada.");
    }
  } catch (error) {
    if (error instanceof EngineRejectedActionError) {
      console.error("[POST /api/games/[id]/advance]", error.message);
      return errorResponse(500, "internal_error", "No se ha podido aplicar la acción.");
    }
    return handleRouteError("POST /api/games/[id]/advance", error);
  }
}

/** 409 con la versión actual cuando se conoce (para que el cliente se sincronice). */
function conflict(code: string, message: string, currentVersion?: number): Response {
  return Response.json(
    { error: { code, message }, ...(currentVersion === undefined ? {} : { currentVersion }) },
    { status: 409, headers: NO_STORE },
  );
}
