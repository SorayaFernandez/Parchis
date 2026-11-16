// Tipos del motor. Sin dependencias de Next.js, React ni servicios externos.

export type Color = "pink" | "purple" | "green" | "blue";

export type PlayerId = string;

/**
 * - `base`: en casa (`steps = -1`).
 * - `track`: en el recorrido común (`steps` 0..63, relativo a su salida). 63 es la
 *   casilla de entrada, la 1ª de las 8 del tramo final.
 * - `final`: en las 7 casillas de color del tramo final (`steps` 68..74).
 * - `finished`: en la meta, posición independiente (`steps = 75`).
 */
export type PieceState = "base" | "track" | "final" | "finished";

export interface Piece {
  state: PieceState;
  steps: number;
  /** Orden de llegada; decide qué ficha se captura si hay varias candidatas. */
  arrivalOrder: number;
}

export interface Player {
  id: PlayerId;
  color: Color;
  pieces: Piece[];
}

export type BonusReason = "capture" | "goal";

export interface PendingBonus {
  playerId: PlayerId;
  amount: number;
  reason: BonusReason;
  /** El movimiento que generó el bonus se hizo con un 6: al terminar, se vuelve a tirar. */
  fromSix: boolean;
}

export interface MovedPieceRef {
  playerId: PlayerId;
  pieceIndex: number;
}

export type GameStatus = "playing" | "finished";

export interface GameState {
  status: GameStatus;
  players: Player[];
  turn: PlayerId;
  /** Dado pendiente de usar por el jugador en turno; `null` si debe tirar. */
  dice: number | null;
  /** Última tirada, para mostrarla aunque ya se haya usado. */
  lastDice: number | null;
  /** Seises seguidos en el turno actual. Se reinicia al cambiar de turno. */
  sixesInTurn: number;
  lastMovedPiece: MovedPieceRef | null;
  pendingBonus: PendingBonus | null;
  /** Jugadores en el orden en que han terminado. */
  ranking: PlayerId[];
  winner: PlayerId | null;
  moveCounter: number;
}

export type GameAction =
  /** `value` lo genera quien llama (el servidor), así el motor es determinista. */
  | { type: "roll"; playerId: PlayerId; value: number }
  /** Usa el dado pendiente o, si lo hay, el bonus pendiente. */
  | { type: "move"; playerId: PlayerId; pieceIndex: number }
  /** El servidor la envía cuando vence el plazo del turno. */
  | { type: "timeout" };

export type MoveError =
  | "PIECE_NOT_FOUND"
  | "NEED_FIVE_TO_EXIT"
  | "OWN_BLOCKADE_ON_EXIT"
  | "EXIT_FULL"
  | "PIECE_FINISHED"
  | "EXACT_ROLL_REQUIRED"
  | "BLOCKADE_IN_PATH"
  | "SAFE_CELL_FULL"
  | "CELL_FULL"
  | "MUST_BREAK_BLOCKADE"
  | "MUST_EXIT_HOME";

export type EngineError =
  | MoveError
  | "GAME_FINISHED"
  | "NOT_YOUR_TURN"
  | "INVALID_DICE_VALUE"
  | "DICE_ALREADY_ROLLED"
  | "BONUS_PENDING"
  | "ROLL_FIRST";

export interface PiecePosition {
  state: PieceState;
  steps: number;
}

export type GameEvent =
  | { type: "dice_rolled"; playerId: PlayerId; value: number }
  | { type: "no_moves"; playerId: PlayerId; value: number }
  | {
      type: "piece_moved";
      playerId: PlayerId;
      pieceIndex: number;
      distance: number;
      from: PiecePosition;
      to: PiecePosition;
      withBonus: boolean;
    }
  | {
      type: "piece_captured";
      playerId: PlayerId;
      victimId: PlayerId;
      victimPieceIndex: number;
      /** Casilla global donde se produjo la captura. */
      cell: number;
    }
  | { type: "piece_reached_goal"; playerId: PlayerId; pieceIndex: number }
  | {
      type: "bonus_granted";
      playerId: PlayerId;
      amount: number;
      reason: BonusReason;
    }
  | {
      type: "bonus_lost";
      playerId: PlayerId;
      amount: number;
      reason: BonusReason;
    }
  | {
      type: "third_six_penalty";
      playerId: PlayerId;
      /** Ficha devuelta a casa; `null` si no había ficha que devolver. */
      pieceIndex: number | null;
    }
  | { type: "roll_again"; playerId: PlayerId }
  | { type: "turn_timeout"; playerId: PlayerId }
  | { type: "turn_changed"; playerId: PlayerId }
  | { type: "player_finished"; playerId: PlayerId; place: number }
  | { type: "game_finished"; winner: PlayerId; ranking: PlayerId[] };

export type ActionResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: EngineError };

export type Validation = { ok: true } | { ok: false; error: MoveError };
