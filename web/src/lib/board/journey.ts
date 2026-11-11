// Recorrido de una ficha medido en casillas avanzadas desde su salida.
// El motor salta de `steps 63` (entrada) a `68` (1ª casilla de color): 64..67 no existen.
// Aquí el recorrido es continuo: 0 = salida, 63 = entrada, 64..70 = casillas de color, 71 = meta.

import {
  FINAL_POSITION,
  FINAL_SECTION_SIZE,
  HOME_ENTRY_STEPS,
  MAIN_TRACK_SIZE,
  type PieceState,
} from "@/lib/engine";

/** Casillas de la salida a la meta: 63 de recorrido + 8 de tramo final = 71. */
export const JOURNEY_LENGTH = HOME_ENTRY_STEPS + FINAL_SECTION_SIZE;

/** Diferencia entre `steps` y casillas avanzadas dentro del pasillo (68 -> 64). */
const STRETCH_GAP = MAIN_TRACK_SIZE - 1 - HOME_ENTRY_STEPS;

/** Casillas avanzadas desde la salida (0 en casa o en la salida, 71 en la meta). */
export function stepsToJourney(steps: number): number {
  if (steps < 0) return 0;
  return steps <= HOME_ENTRY_STEPS ? steps : steps - STRETCH_GAP;
}

/** Inversa de `stepsToJourney` para 0..71. */
export function journeyToSteps(journey: number): number {
  return journey <= HOME_ENTRY_STEPS ? journey : journey + STRETCH_GAP;
}

/**
 * `steps` de cada casilla que pisa una ficha al ir de `from` a `to` (sin `from`, con `to`).
 * Al salir de casa, la única casilla es la salida.
 */
export function journeySteps(from: number, to: number): number[] {
  if (from < 0) return [to];
  const result: number[] = [];
  for (let j = stepsToJourney(from) + 1; j <= stepsToJourney(to); j++) result.push(journeyToSteps(j));
  return result;
}

/** Estado de una ficha según sus `steps` (mismo convenio que el motor). */
export function pieceStateForSteps(steps: number): PieceState {
  if (steps < 0) return "base";
  if (steps >= FINAL_POSITION) return "finished";
  if (steps >= MAIN_TRACK_SIZE) return "final";
  return "track";
}
