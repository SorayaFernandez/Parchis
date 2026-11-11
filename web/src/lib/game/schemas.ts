// Esquemas Zod para validar en tiempo de ejecución los datos que llegan de Supabase
// (filas leídas en el servidor y, más adelante, eventos de Realtime en el navegador).
// Cada esquema está tipado contra el tipo del motor (`z.ZodType<GameState>`, etc.):
// si el motor cambia un tipo, TypeScript avisa de que el esquema ya no coincide.

import { z } from "zod";
import {
  FINAL_POSITION,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PIECES_PER_PLAYER,
  type GameAction,
  type GameEvent,
  type GameState,
  type PiecePosition,
} from "@/lib/engine";

/** Versión del formato de `GameState` guardado (columna `engine_version`). */
export const ENGINE_STATE_VERSION = 1;

// ─── Piezas básicas ─────────────────────────────────────────────────────────

const playerId = z.string().min(1);
const color = z.enum(["pink", "purple", "green", "blue"]);
const pieceState = z.enum(["base", "track", "final", "finished"]);
const bonusReason = z.enum(["capture", "goal"]);
const int = z.number().int();
const steps = int.min(-1).max(FINAL_POSITION);
const pieceIndex = int.min(0).max(PIECES_PER_PLAYER - 1);
const diceValue = int.min(1).max(6);

const piecePosition: z.ZodType<PiecePosition> = z.object({ state: pieceState, steps });

// ─── GameState ──────────────────────────────────────────────────────────────

export const GameStateSchema: z.ZodType<GameState> = z
  .object({
    status: z.enum(["playing", "finished"]),
    players: z
      .array(
        z.object({
          id: playerId,
          color,
          pieces: z
            .array(z.object({ state: pieceState, steps, arrivalOrder: int.min(0) }))
            .length(PIECES_PER_PLAYER),
        }),
      )
      .min(MIN_PLAYERS)
      .max(MAX_PLAYERS),
    turn: playerId,
    dice: diceValue.nullable(),
    lastDice: diceValue.nullable(),
    sixesInTurn: int.min(0),
    lastMovedPiece: z.object({ playerId, pieceIndex }).nullable(),
    pendingBonus: z.object({ playerId, amount: int.positive(), reason: bonusReason, fromSix: z.boolean() }).nullable(),
    ranking: z.array(playerId),
    winner: playerId.nullable(),
    moveCounter: int.min(0),
  })
  .superRefine((state, ctx) => {
    // Coherencia de referencias entre jugadores (lo que un JSON corrupto podría romper).
    const ids = state.players.map((p) => p.id);
    const known = new Set(ids);
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });

    if (known.size !== ids.length) issue("ids de jugador repetidos");
    if (new Set(state.players.map((p) => p.color)).size !== state.players.length) issue("colores repetidos");
    if (!known.has(state.turn)) issue("turn no es un jugador");
    if (state.winner !== null && !known.has(state.winner)) issue("winner no es un jugador");
    if (state.ranking.some((id) => !known.has(id))) issue("ranking con jugadores desconocidos");
    if ((state.status === "finished") !== (state.winner !== null)) issue("status y winner incoherentes");
  });

// ─── Acciones ───────────────────────────────────────────────────────────────

export const GameActionSchema: z.ZodType<GameAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("roll"), playerId, value: diceValue }),
  z.object({ type: z.literal("move"), playerId, pieceIndex }),
  z.object({ type: z.literal("timeout") }),
]);

// ─── Eventos ────────────────────────────────────────────────────────────────

export const GameEventSchema: z.ZodType<GameEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dice_rolled"), playerId, value: diceValue }),
  z.object({ type: z.literal("no_moves"), playerId, value: diceValue }),
  z.object({
    type: z.literal("piece_moved"),
    playerId,
    pieceIndex,
    distance: int.positive(),
    from: piecePosition,
    to: piecePosition,
    withBonus: z.boolean(),
  }),
  z.object({ type: z.literal("piece_captured"), playerId, victimId: playerId, victimPieceIndex: pieceIndex, cell: int.min(0).max(67) }),
  z.object({ type: z.literal("piece_reached_goal"), playerId, pieceIndex }),
  z.object({ type: z.literal("bonus_granted"), playerId, amount: int.positive(), reason: bonusReason }),
  z.object({ type: z.literal("bonus_lost"), playerId, amount: int.positive(), reason: bonusReason }),
  z.object({ type: z.literal("third_six_penalty"), playerId, pieceIndex: pieceIndex.nullable() }),
  z.object({ type: z.literal("roll_again"), playerId }),
  z.object({ type: z.literal("turn_timeout"), playerId }),
  z.object({ type: z.literal("turn_changed"), playerId }),
  z.object({ type: z.literal("player_finished"), playerId, place: int.min(1).max(MAX_PLAYERS) }),
  z.object({ type: z.literal("game_finished"), winner: playerId, ranking: z.array(playerId) }),
]);

// ─── Fila de `public.games` ─────────────────────────────────────────────────

/** Fila tal como la devuelve Supabase (snake_case; fechas como cadenas ISO). */
export const GameRowSchema = z
  .object({
    id: z.uuid(),
    state: GameStateSchema,
    engine_version: int.min(1),
    status: z.enum(["playing", "finished"]),
    winner: playerId.nullable(),
    version: int.min(1),
    lock_token: z.uuid().nullable(),
    processing_until: z.string().nullable(),
    last_action: GameActionSchema.nullable(),
    last_events: z.array(GameEventSchema),
    created_at: z.string(),
    updated_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .superRefine((row, ctx) => {
    // Las columnas generadas deben coincidir con el estado.
    if (row.status !== row.state.status || row.winner !== row.state.winner) {
      ctx.addIssue({ code: "custom", message: "status/winner no coinciden con state" });
    }
  });

export type GameRow = z.infer<typeof GameRowSchema>;

/** Partida almacenada, en el formato que usa la aplicación (camelCase). */
export interface StoredGame {
  id: string;
  state: GameState;
  version: number;
  engineVersion: number;
  status: GameState["status"];
  winner: string | null;
  lastAction: GameAction | null;
  lastEvents: GameEvent[];
  /** Hora límite de la reserva en curso (null si no hay ninguna). No incluye el token. */
  processingUntil: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export function toStoredGame(row: GameRow): StoredGame {
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    engineVersion: row.engine_version,
    status: row.status,
    winner: row.winner,
    lastAction: row.last_action,
    lastEvents: row.last_events,
    processingUntil: row.processing_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}
