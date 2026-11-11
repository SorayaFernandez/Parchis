// Datos que muestra el HUD, derivados del estado del motor. Sin reglas propias:
// lo que se puede hacer (tirar, mover) se obtiene del propio estado y de getAvailableMoves.

import { JOURNEY_LENGTH, stepsToJourney } from "@/lib/board/journey";
import {
  MAX_CONSECUTIVE_SIXES,
  getAvailableMoves,
  type BonusReason,
  type Color,
  type GameState,
  type Piece,
  type PlayerId,
} from "@/lib/engine";

/** Casillas que recorre una ficha desde la salida hasta la meta (63 + 8 = 71). */
export const PIECE_JOURNEY = JOURNEY_LENGTH;

/** Casillas avanzadas por una ficha desde su salida (0 en casa, 71 en la meta). */
export const pieceProgress = (piece: Pick<Piece, "steps">): number => stepsToJourney(piece.steps);

export type PlayerStatus = "turn" | "waiting" | "finished";

export interface PlayerSummary {
  id: PlayerId;
  color: Color;
  status: PlayerStatus;
  /** Puesto final (1 = ganador) si ya ha terminado. */
  place: number | null;
  pieces: { base: number; track: number; final: number; finished: number };
  /** Progreso total de sus 4 fichas, de 0 a 100. */
  progress: number;
}

export function getPlayerSummaries(state: GameState): PlayerSummary[] {
  return state.players.map((player) => {
    const pieces = { base: 0, track: 0, final: 0, finished: 0 };
    for (const piece of player.pieces) pieces[piece.state]++;

    const advanced = player.pieces.reduce((sum, p) => sum + pieceProgress(p), 0);
    const rankIndex = state.ranking.indexOf(player.id);
    const finished = rankIndex >= 0;

    return {
      id: player.id,
      color: player.color,
      status: finished ? "finished" : state.status === "playing" && state.turn === player.id ? "turn" : "waiting",
      place: finished ? rankIndex + 1 : null,
      pieces,
      progress: Math.round((advanced / (PIECE_JOURNEY * player.pieces.length)) * 100),
    };
  });
}

export type TurnPhase =
  /** Debe tirar el dado. */
  | { kind: "roll" }
  /** Ha tirado y debe elegir ficha. */
  | { kind: "move"; dice: number; movablePieces: number[] }
  /** Debe mover una ficha con el bonus pendiente. */
  | { kind: "bonus"; amount: number; reason: BonusReason; rollAgain: boolean; movablePieces: number[] }
  | { kind: "finished"; winner: PlayerId };

export interface TurnInfo {
  playerId: PlayerId;
  color: Color;
  phase: TurnPhase;
  /** Último valor del dado (aunque ya se haya usado). */
  lastDice: number | null;
  sixesInTurn: number;
  maxSixes: number;
  canRoll: boolean;
}

export function getTurnInfo(state: GameState): TurnInfo {
  const player = state.players.find((p) => p.id === state.turn)!;
  const base = {
    playerId: player.id,
    color: player.color,
    lastDice: state.lastDice,
    sixesInTurn: state.sixesInTurn,
    maxSixes: MAX_CONSECUTIVE_SIXES,
  };

  if (state.status === "finished" && state.winner) {
    return { ...base, phase: { kind: "finished", winner: state.winner }, canRoll: false };
  }
  if (state.pendingBonus) {
    const { amount, reason, fromSix } = state.pendingBonus;
    return {
      ...base,
      phase: { kind: "bonus", amount, reason, rollAgain: fromSix, movablePieces: getAvailableMoves(state) },
      canRoll: false,
    };
  }
  if (state.dice !== null) {
    return {
      ...base,
      phase: { kind: "move", dice: state.dice, movablePieces: getAvailableMoves(state) },
      canRoll: false,
    };
  }
  return { ...base, phase: { kind: "roll" }, canRoll: true };
}
