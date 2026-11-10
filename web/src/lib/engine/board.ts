// Posiciones y barreras.
// Portado de backend/game/utils/{getRealBoardPosition,getDistanceToHomeEntry,
// isEnteringHomeStretch}.js y backend/game/rules/{getBlockades,isPositionBlocked,
// isDestinationBlocked}.js. isBlockade.js e isEnemyBlockade.js no se usaban.

import {
  HOME_ENTRIES,
  MAIN_TRACK_SIZE,
  SAFE_CELLS,
  START_POSITIONS,
} from "./constants";
import type { Color, GameState, Piece } from "./types";

/** La ficha está en el recorrido común (no en casa, en el pasillo ni en la meta). */
export function isOnMainTrack(piece: Pick<Piece, "steps">): boolean {
  return piece.steps >= 0 && piece.steps < MAIN_TRACK_SIZE;
}

/** Convierte `steps` relativos de un color en una casilla global (0..67), o -1 si está en casa. */
export function getRealBoardPosition(color: Color, steps: number): number {
  if (steps < 0) return -1;
  return (START_POSITIONS[color] + steps) % MAIN_TRACK_SIZE;
}

export function isSafeCell(cell: number): boolean {
  return SAFE_CELLS.has(cell);
}

/** Casillas que faltan desde la posición actual hasta la entrada del pasillo. */
export function getDistanceToHomeEntry(color: Color, steps: number): number {
  const current = getRealBoardPosition(color, steps);
  const entry = HOME_ENTRIES[color];
  if (current <= entry) return entry - current;
  return MAIN_TRACK_SIZE - current + entry;
}

/** Avanzar `distance` casillas desde `steps` hace entrar a la ficha en el pasillo. */
export function isEnteringHomeStretch(
  color: Color,
  steps: number,
  distance: number,
): boolean {
  return distance > getDistanceToHomeEntry(color, steps);
}

export interface Blockade {
  color: Color;
  cell: number;
}

/** Barreras: dos o más fichas del mismo color en la misma casilla del recorrido. */
export function getBlockades(state: GameState): Blockade[] {
  const blockades: Blockade[] = [];
  for (const player of state.players) {
    const count = new Map<number, number>();
    for (const piece of player.pieces) {
      if (!isOnMainTrack(piece)) continue;
      const cell = getRealBoardPosition(player.color, piece.steps);
      count.set(cell, (count.get(cell) ?? 0) + 1);
    }
    for (const [cell, n] of count) {
      if (n >= 2) blockades.push({ color: player.color, cell });
    }
  }
  return blockades;
}

/** Hay una barrera en `cell`, sin contar la que esté en `ignoreCell`. */
export function isCellBlocked(
  state: GameState,
  cell: number,
  ignoreCell: number | null = null,
): boolean {
  return getBlockades(state).some(
    (b) => b.cell === cell && b.cell !== ignoreCell,
  );
}

/** Número total de fichas (de cualquier color) en una casilla del recorrido. */
export function countPiecesOnCell(state: GameState, cell: number): number {
  let count = 0;
  for (const player of state.players) {
    for (const piece of player.pieces) {
      if (!isOnMainTrack(piece)) continue;
      if (getRealBoardPosition(player.color, piece.steps) === cell) count++;
    }
  }
  return count;
}
