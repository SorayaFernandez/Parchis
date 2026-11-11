import { expect } from "vitest";
import { FINAL_POSITION, HOME_ENTRY_STEPS, MAIN_TRACK_SIZE, START_POSITIONS } from "../constants";
import { applyAction, createGame } from "../engine";
import type { ActionResult, Color, GameAction, GameState, PieceState } from "../types";

/** Los ids coinciden con el color asignado (createGame asigna en el orden de COLORS). */
export const ALL = ["pink", "purple", "green", "blue"] as const;

export function stateForSteps(steps: number): PieceState {
  if (steps < 0) return "base";
  if (steps === FINAL_POSITION) return "finished";
  if (steps >= MAIN_TRACK_SIZE) return "final";
  return "track";
}

/** `steps` relativos que corresponden a una casilla global para un color. */
export function stepsForCell(color: Color, cell: number): number {
  const steps = (cell - START_POSITIONS[color] + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;
  if (steps > HOME_ENTRY_STEPS) throw new Error(`${color} no puede estar en la casilla ${cell}`);
  return steps;
}

/**
 * Crea una partida y coloca las fichas indicadas (por `steps`; -1 = casa).
 * Los colores sin datos quedan con todas las fichas en casa.
 */
export function setup(
  pieces: Partial<Record<Color, number[]>>,
  playerIds: readonly string[] = ALL,
): GameState {
  const state = createGame([...playerIds]);
  let order = 0;
  for (const player of state.players) {
    const steps = pieces[player.color];
    if (!steps) continue;
    steps.forEach((s, i) => {
      player.pieces[i] = { steps: s, state: stateForSteps(s), arrivalOrder: ++order };
    });
  }
  state.moveCounter = order;
  return state;
}

export function steps(state: GameState, color: Color): number[] {
  return state.players.find((p) => p.color === color)!.pieces.map((p) => p.steps);
}

export function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(`Acción rechazada: ${result.error}`);
  return result.state;
}

export function run(state: GameState, action: GameAction) {
  const result = applyAction(state, action);
  expect(result.ok, !result.ok ? result.error : "").toBe(true);
  return result as Extract<ActionResult, { ok: true }>;
}

export function eventTypes(result: { events: { type: string }[] }): string[] {
  return result.events.map((e) => e.type);
}
