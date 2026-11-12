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
  /** Color de la barrera, o `null` si la forman fichas de colores distintos (solo en casillas seguras). */
  color: Color | null;
  cell: number;
}

/**
 * Barreras del recorrido común (el pasillo final y la meta no cuentan):
 * - En una casilla normal, dos o más fichas del mismo color.
 * - En una casilla segura, dos fichas de cualquier color (iguales o distintos).
 * Una barrera bloquea el paso y el destino a todas las fichas, de cualquier color.
 * (En el original solo había barreras del mismo color.)
 */
export function getBlockades(state: GameState): Blockade[] {
  const byCell = new Map<number, Color[]>();
  for (const player of state.players) {
    for (const piece of player.pieces) {
      if (!isOnMainTrack(piece)) continue;
      const cell = getRealBoardPosition(player.color, piece.steps);
      const colors = byCell.get(cell) ?? [];
      colors.push(player.color);
      byCell.set(cell, colors);
    }
  }
  const blockades: Blockade[] = [];
  for (const [cell, colors] of byCell) {
    if (isSafeCell(cell)) {
      if (colors.length >= 2) blockades.push({ color: colors.every((c) => c === colors[0]) ? colors[0] : null, cell });
      continue;
    }
    const perColor = new Map<Color, number>();
    for (const color of colors) perColor.set(color, (perColor.get(color) ?? 0) + 1);
    for (const [color, n] of perColor) {
      if (n >= 2) blockades.push({ color, cell });
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
