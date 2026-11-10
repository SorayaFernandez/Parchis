// Validación, movimientos legales, aplicación de movimientos y capturas.
// Portado de backend/game/validators/canMovePiece.js,
// backend/game/rules/{getAvailableMoves,applyMove,checkCapture,checkWin}.js.

import {
  countPiecesOnCell,
  getBlockades,
  getDistanceToHomeEntry,
  getRealBoardPosition,
  isCellBlocked,
  isEnteringHomeStretch,
  isOnMainTrack,
  isSafeCell,
} from "./board";
import {
  BASE_STEPS,
  EXIT_ROLL,
  EXTRA_ROLL_VALUE,
  FINAL_POSITION,
  MAIN_TRACK_SIZE,
  MAX_PIECES_NORMAL_CELL,
  MAX_PIECES_ON_EXIT,
  MAX_PIECES_SAFE_CELL,
  PIECES_PER_PLAYER,
} from "./constants";
import type {
  GameState,
  Piece,
  PiecePosition,
  Player,
  PlayerId,
  Validation,
} from "./types";

export function getPlayer(state: GameState, playerId: PlayerId): Player | undefined {
  return state.players.find((p) => p.id === playerId);
}

/** Casillas que se mueven ahora: el bonus pendiente o, si no hay, el dado. */
export function getMoveDistance(state: GameState): number | null {
  return state.pendingBonus?.amount ?? state.dice;
}

/**
 * Comprueba si una ficha puede avanzar `distance` casillas según las reglas del tablero.
 * No comprueba el turno ni la obligación de abrir barrera (ver `getLegalMoves`).
 */
export function canMovePiece(
  state: GameState,
  playerId: PlayerId,
  pieceIndex: number,
  distance: number,
): Validation {
  const player = getPlayer(state, playerId);
  const piece = player?.pieces[pieceIndex];
  if (!player || !piece) return { ok: false, error: "PIECE_NOT_FOUND" };

  if (piece.state === "base") {
    if (distance !== EXIT_ROLL) return { ok: false, error: "NEED_FIVE_TO_EXIT" };

    const exitCell = getRealBoardPosition(player.color, 0);
    // Solo cuentan las fichas del recorrido. El original contaba también una ficha
    // propia en la primera casilla del pasillo (steps 68), porque (salida + 68) % 68
    // coincide con la salida.
    const ownOnExit = player.pieces.filter(
      (p) => isOnMainTrack(p) && getRealBoardPosition(player.color, p.steps) === exitCell,
    ).length;
    if (ownOnExit >= 2) return { ok: false, error: "OWN_BLOCKADE_ON_EXIT" };

    // Al salir se captura una ficha rival de la salida, si la hay.
    const enemiesOnExit = countPiecesOnCell(state, exitCell) - ownOnExit;
    const remainingAfterCapture = ownOnExit + Math.max(enemiesOnExit - 1, 0);
    if (remainingAfterCapture + 1 > MAX_PIECES_ON_EXIT) {
      return { ok: false, error: "EXIT_FULL" };
    }
    return { ok: true };
  }

  if (piece.state === "finished") return { ok: false, error: "PIECE_FINISHED" };

  // En el pasillo final.
  if (piece.steps >= MAIN_TRACK_SIZE) {
    if (piece.steps + distance > FINAL_POSITION) {
      return { ok: false, error: "EXACT_ROLL_REQUIRED" };
    }
    return { ok: true };
  }

  // En el recorrido: ninguna barrera en el camino ni en el destino. Se ignora la
  // barrera de la casilla de partida, por si la ficha está rompiendo una propia.
  // En el original había una comprobación aparte para el destino, pero este bucle
  // ya lo cubre.
  const startCell = getRealBoardPosition(player.color, piece.steps);
  for (let step = 1; step <= distance; step++) {
    if (isEnteringHomeStretch(player.color, piece.steps, step)) break;
    const cell = getRealBoardPosition(player.color, piece.steps + step);
    if (isCellBlocked(state, cell, startCell)) {
      return { ok: false, error: "BLOCKADE_IN_PATH" };
    }
  }

  if (isEnteringHomeStretch(player.color, piece.steps, distance)) {
    const overshoot = distance - getDistanceToHomeEntry(player.color, piece.steps) - 1;
    if (MAIN_TRACK_SIZE + overshoot > FINAL_POSITION) {
      return { ok: false, error: "EXACT_ROLL_REQUIRED" };
    }
    return { ok: true };
  }

  const targetCell = getRealBoardPosition(player.color, piece.steps + distance);
  const safe = isSafeCell(targetCell);
  const max = safe ? MAX_PIECES_SAFE_CELL : MAX_PIECES_NORMAL_CELL;
  if (countPiecesOnCell(state, targetCell) >= max) {
    return { ok: false, error: safe ? "SAFE_CELL_FULL" : "CELL_FULL" };
  }
  return { ok: true };
}

/**
 * Índices de las fichas que el jugador puede mover `distance` casillas.
 * Con un 6 de dado, si tiene alguna barrera propia, solo puede mover fichas
 * que la abran (aunque eso deje la lista vacía, igual que en el original).
 */
export function getLegalMoves(
  state: GameState,
  playerId: PlayerId,
  distance: number,
): number[] {
  const moves: number[] = [];
  for (let i = 0; i < PIECES_PER_PLAYER; i++) {
    if (canMovePiece(state, playerId, i, distance).ok) moves.push(i);
  }

  if (distance !== EXTRA_ROLL_VALUE) return moves;

  const player = getPlayer(state, playerId);
  if (!player) return moves;

  // El original solo miraba la primera barrera propia; aquí se consideran todas.
  const ownBlockadeCells = new Set(
    getBlockades(state)
      .filter((b) => b.color === player.color)
      .map((b) => b.cell),
  );
  if (ownBlockadeCells.size === 0) return moves;

  return moves.filter((i) => {
    const piece = player.pieces[i];
    return (
      isOnMainTrack(piece) &&
      ownBlockadeCells.has(getRealBoardPosition(player.color, piece.steps))
    );
  });
}

export function toPosition(piece: Piece): PiecePosition {
  return { state: piece.state, steps: piece.steps };
}

export interface AppliedMove {
  leftBase: boolean;
  reachedGoal: boolean;
}

/** Avanza la ficha (modifica `state`). Hay que validar antes con `canMovePiece`. */
export function applyPieceMove(
  state: GameState,
  player: Player,
  pieceIndex: number,
  distance: number,
): AppliedMove {
  const piece = player.pieces[pieceIndex];
  piece.arrivalOrder = ++state.moveCounter;

  if (piece.state === "base") {
    piece.state = "track";
    piece.steps = 0;
    return { leftBase: true, reachedGoal: false };
  }

  if (piece.steps >= MAIN_TRACK_SIZE) {
    piece.steps += distance;
  } else if (isEnteringHomeStretch(player.color, piece.steps, distance)) {
    const overshoot = distance - getDistanceToHomeEntry(player.color, piece.steps) - 1;
    piece.steps = MAIN_TRACK_SIZE + overshoot;
    piece.state = "final";
  } else {
    piece.steps += distance;
  }

  const reachedGoal = piece.steps === FINAL_POSITION;
  if (reachedGoal) piece.state = "finished";
  return { leftBase: false, reachedGoal };
}

export function sendPieceToBase(piece: Piece): void {
  piece.state = "base";
  piece.steps = BASE_STEPS;
}

export interface Capture {
  victimId: PlayerId;
  victimPieceIndex: number;
  cell: number;
}

/**
 * Captura una ficha rival en la casilla donde ha caído la ficha movida (modifica `state`).
 * No hay captura en casillas seguras ni en barreras, salvo al salir de casa
 * a la propia salida. Si hay varias candidatas, se captura la que llegó la última.
 */
export function resolveCapture(
  state: GameState,
  player: Player,
  movedPiece: Piece,
  leftBase: boolean,
): Capture | null {
  if (!isOnMainTrack(movedPiece)) return null;

  const cell = getRealBoardPosition(player.color, movedPiece.steps);
  const exitingToOwnStart = leftBase && movedPiece.steps === 0;
  if (!exitingToOwnStart && (isSafeCell(cell) || isCellBlocked(state, cell))) {
    return null;
  }

  let victim: Player | null = null;
  let victimIndex = -1;
  for (const enemy of state.players) {
    if (enemy.id === player.id) continue;
    for (let index = 0; index < enemy.pieces.length; index++) {
      const piece = enemy.pieces[index];
      if (!isOnMainTrack(piece)) continue;
      if (getRealBoardPosition(enemy.color, piece.steps) !== cell) continue;
      if (!victim || piece.arrivalOrder > victim.pieces[victimIndex].arrivalOrder) {
        victim = enemy;
        victimIndex = index;
      }
    }
  }
  if (!victim) return null;

  sendPieceToBase(victim.pieces[victimIndex]);
  return { victimId: victim.id, victimPieceIndex: victimIndex, cell };
}

export function hasFinishedAllPieces(player: Player): boolean {
  return player.pieces.every((p) => p.steps === FINAL_POSITION);
}
