export type PieceState =
  | "base"
  | "track"
  | "final"
  | "finished";

export interface PieceCoords {
  x: number;
  y: number;
}

export interface Piece {
  id: string;

  state: PieceState;

  position: number;

  coords: PieceCoords | null;
}

export interface Player {
  id: number;

  username: string;

  avatar_url: string;

  color:
    | "pink"
    | "purple"
    | "green"
    | "blue";

  connected: boolean;

  abandoned: boolean;

  pieces: Piece[];
}

export interface Spectator {
  id: number;

  username: string;

  avatar_url: string | null;
}

export type GameStatus =
  | "waiting"
  | "playing"
  | "finished";

export interface Game {
  id: string;

  status: GameStatus;

  turn: number;

  dice: number | null;

  availableMoves?: number[];

  lastDice?: number | null;

  winner?: number | null;

  players: Player[];

  spectators?: Spectator[];

  bonusMove?: number | null;

  bonusReason?: "capture" | "goal" | null;

  pendingBonus?: number | null;

  pendingBonusPlayer?: number | null;
}