// Estado de ejemplo para la página de demostración del tablero (no es parte del juego).

import {
  FINAL_POSITION,
  MAIN_TRACK_SIZE,
  START_POSITIONS,
  createGame,
  type Color,
  type GameState,
} from "@/lib/engine";
import { pieceStateForSteps } from "./journey";

/** `steps` de un color para estar en una casilla global del recorrido. */
function stepsAtCell(color: Color, cell: number): number {
  return (cell - START_POSITIONS[color] + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;
}

/** Jugadores de la demo (en el orden de COLORS: pink, purple, green, blue). Nombres provisionales hasta tener los personajes de IA. */
export const DEMO_PLAYER_IDS = ["rosa", "morado", "verde", "azul"] as const;

export const DEMO_PLAYER_NAMES: Readonly<Record<string, string>> = {
  rosa: "Rosa",
  morado: "Morado",
  verde: "Verde",
  azul: "Azul",
};

export function createDemoGame(): GameState {
  return createGame([...DEMO_PLAYER_IDS]);
}

/**
 * Un caso de cada: fichas en casa, en la salida, una barrera, dos colores en un seguro,
 * fichas en los cuatro pasillos finales y en la meta.
 */
export function createShowcaseState(): GameState {
  const state = createDemoGame();
  const layout: Record<Color, number[]> = {
    pink: [-1, -1, 0, 70],
    purple: [stepsAtCell("purple", 44), stepsAtCell("purple", 44), FINAL_POSITION, 69],
    green: [stepsAtCell("green", 63), 71, FINAL_POSITION, FINAL_POSITION],
    blue: [stepsAtCell("blue", 63), 68, -1, 72],
  };

  let order = 0;
  for (const player of state.players) {
    player.pieces = layout[player.color].map((steps) => ({
      steps,
      state: pieceStateForSteps(steps),
      arrivalOrder: ++order,
    }));
  }
  state.moveCounter = order;
  return state;
}
