// Contrato de lectura de una partida: lo devuelve GET /api/games/[id] y lo recibe la página
// /partida/[id]. Sin dependencias de servidor (los componentes lo usan como tipo).

import { z } from "zod";
import { GameActionSchema, GameEventSchema, GameStateSchema, type StoredGame } from "./schemas";

/** Partida tal como se expone. No incluye datos internos (`lock_token`, plazo de reserva, formato). */
export const GameResponseSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().min(1),
    status: z.enum(["playing", "finished"]),
    winner: z.string().min(1).nullable(),
    state: GameStateSchema,
    /** Acción que llevó a esta versión (`null` en la versión 1). */
    lastAction: GameActionSchema.nullable(),
    /** Eventos de esa acción (vacío en la versión 1). */
    lastEvents: z.array(GameEventSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .refine((game) => game.status === game.state.status && game.winner === game.state.winner, {
    error: "status/winner no coinciden con state",
  });

export type GameResponse = z.infer<typeof GameResponseSchema>;

export function toGameResponse(game: StoredGame): GameResponse {
  return {
    id: game.id,
    version: game.version,
    status: game.status,
    winner: game.winner,
    state: game.state,
    lastAction: game.lastAction,
    lastEvents: game.lastEvents,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    finishedAt: game.finishedAt,
  };
}

/** Resultado de cargar una partida para mostrarla. */
export type LoadGameResult =
  | { kind: "ok"; game: GameResponse }
  | { kind: "not_found" }
  /** No se ha podido recuperar (BD, red, datos no válidos…). Se puede reintentar. */
  | { kind: "error"; message: string };
