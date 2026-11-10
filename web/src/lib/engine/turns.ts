// Cambio de turno. Portado de backend/game/rules/nextTurn.js.

import { TURN_ORDER } from "./constants";
import type { GameEvent, GameState, PlayerId } from "./types";

/** Siguiente jugador en orden de turno que no haya terminado, o `null` si no queda ninguno. */
export function findNextPlayer(state: GameState): PlayerId | null {
  const current = state.players.find((p) => p.id === state.turn);
  const start = current ? TURN_ORDER.indexOf(current.color) : -1;

  // A diferencia del original (do/while sin límite), como mucho da una vuelta.
  for (let offset = 1; offset <= TURN_ORDER.length; offset++) {
    const color = TURN_ORDER[(start + offset) % TURN_ORDER.length];
    const candidate = state.players.find((p) => p.color === color);
    if (candidate && !state.ranking.includes(candidate.id)) return candidate.id;
  }
  return null;
}

/** Pasa el turno (modifica `state`): reinicia el dado, el bonus y el contador de seises. */
export function passTurn(state: GameState, events: GameEvent[]): void {
  state.dice = null;
  state.pendingBonus = null;
  state.sixesInTurn = 0;

  const next = findNextPlayer(state);
  if (next === null) return;
  state.turn = next;
  events.push({ type: "turn_changed", playerId: next });
}
