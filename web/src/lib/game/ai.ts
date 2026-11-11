// IA heurística sencilla (sin LLM). Elige entre los movimientos legales que da el motor.
// Cada candidato se simula con el propio motor (applyAction es puro), así que las reglas
// (capturas, meta, bonus, barreras…) no se duplican aquí: solo se puntúa el resultado.

import {
  MAIN_TRACK_SIZE,
  applyAction,
  getAvailableMoves,
  getRealBoardPosition,
  isOnMainTrack,
  isSafeCell,
  type GameAction,
  type GameEvent,
  type GameState,
  type Player,
} from "@/lib/engine";

/** Pesos de la heurística (cuanto mayor, más se prefiere). */
export const AI_WEIGHTS = {
  capture: 1000,
  reachGoal: 800,
  leaveBase: 400,
  enterFinalStretch: 250,
  landOnSafeCell: 120,
  /** Por cada casilla avanzada. */
  progressPerStep: 1,
  /** Por cada ficha rival que podría capturarla en su próximo turno (1-6 casillas por detrás). */
  threatPerEnemy: -150,
  /** Formar o mantener una barrera propia. */
  blockade: 60,
} as const;

/** Fichas rivales del recorrido que están entre 1 y 6 casillas por detrás de `cell`. */
function threatsAt(state: GameState, player: Player, cell: number): number {
  let threats = 0;
  for (const enemy of state.players) {
    if (enemy.id === player.id) continue;
    for (const piece of enemy.pieces) {
      if (!isOnMainTrack(piece)) continue;
      const behind = (cell - getRealBoardPosition(enemy.color, piece.steps) + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;
      if (behind >= 1 && behind <= 6) threats++;
    }
  }
  return threats;
}

/** Puntuación de mover `pieceIndex` (simulado con el motor). `-Infinity` si el motor lo rechaza. */
export function scoreMove(state: GameState, pieceIndex: number): number {
  const result = applyAction(state, { type: "move", playerId: state.turn, pieceIndex });
  if (!result.ok) return Number.NEGATIVE_INFINITY;

  const moved = result.events.find(
    (e): e is Extract<GameEvent, { type: "piece_moved" }> => e.type === "piece_moved",
  );
  if (!moved) return Number.NEGATIVE_INFINITY;

  const player = result.state.players.find((p) => p.id === state.turn)!;
  const piece = player.pieces[pieceIndex];
  let score = 0;

  if (result.events.some((e) => e.type === "piece_captured")) score += AI_WEIGHTS.capture;
  if (result.events.some((e) => e.type === "piece_reached_goal")) score += AI_WEIGHTS.reachGoal;
  if (moved.from.state === "base") score += AI_WEIGHTS.leaveBase;
  if (moved.from.state === "track" && moved.to.state === "final") score += AI_WEIGHTS.enterFinalStretch;
  score += moved.distance * AI_WEIGHTS.progressPerStep;

  // Riesgo y seguridad solo cuentan en el recorrido común (en el pasillo nadie captura).
  if (isOnMainTrack(piece)) {
    const cell = getRealBoardPosition(player.color, piece.steps);
    if (isSafeCell(cell)) {
      score += AI_WEIGHTS.landOnSafeCell;
    } else {
      score += threatsAt(result.state, player, cell) * AI_WEIGHTS.threatPerEnemy;
      const partners = player.pieces.filter(
        (p, i) => i !== pieceIndex && isOnMainTrack(p) && getRealBoardPosition(player.color, p.steps) === cell,
      ).length;
      if (partners > 0) score += AI_WEIGHTS.blockade;
    }
  }
  return score;
}

/** Mejor ficha entre los movimientos legales; los empates se resuelven por el índice más bajo. */
export function chooseMove(state: GameState, legalMoves: readonly number[]): number {
  let best = legalMoves[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const index of legalMoves) {
    const score = scoreMove(state, index);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Siguiente acción del jugador en turno.
 * - Sin dado ni bonus pendiente: tirar (el valor lo da `rollDie`, en el servidor crypto.randomInt).
 * - Con dado o bonus: mover la ficha elegida por la heurística.
 * - Con dado o bonus pero sin movimientos legales (el motor no debería llegar a ese estado):
 *   `timeout`, que pasa el turno según las reglas, para que la partida nunca se bloquee.
 */
export function decideAction(state: GameState, rollDie: () => number): GameAction {
  if (state.status !== "playing") throw new Error("La partida ha terminado");
  if (state.dice === null && state.pendingBonus === null) {
    return { type: "roll", playerId: state.turn, value: rollDie() };
  }
  const moves = getAvailableMoves(state);
  if (moves.length === 0) return { type: "timeout" };
  return { type: "move", playerId: state.turn, pieceIndex: chooseMove(state, moves) };
}
