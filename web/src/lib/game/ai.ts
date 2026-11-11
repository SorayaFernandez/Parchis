// IA heurística (sin LLM). Elige entre los movimientos legales que da el motor.
// Cada candidato se simula con el propio motor (applyAction es puro), así que las reglas
// (capturas, meta, bonus, barreras…) no se duplican aquí: solo se puntúa el resultado.
// Cada personaje puntúa con su propio perfil (`characters.ts`): multiplicadores sobre los pesos
// base y, en el caso de Chispa, un azar acotado. El azar se inyecta (`random`), así que el módulo
// sigue siendo puro y reproducible con una semilla.

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
import { getStrategy, type StrategyCriterion, type StrategyProfile } from "./characters";

/** Pesos base de la heurística (cuanto mayor, más se prefiere). Cada perfil los multiplica. */
export const AI_WEIGHTS: Readonly<Record<StrategyCriterion, number>> = {
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
  /** Por cada ficha rival capturable a 1-6 casillas por delante (en una casilla no segura). */
  huntPerTarget: 30,
};

/** Generador de números en [0, 1). En el servidor: crypto; en las pruebas: `createSeededRandom`. */
export type RandomSource = () => number;

export interface ChooseOptions {
  /** Perfil con el que puntuar. Por defecto, el del jugador en turno. */
  strategy?: StrategyProfile;
  /** Solo se usa si el perfil tiene azar. Sin `random`, se elige siempre la mejor jugada. */
  random?: RandomSource;
}

/** Distancia (0–67) desde `from` hasta `to` en el sentido de avance. */
const ahead = (from: number, to: number) => (to - from + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;

/** Fichas rivales del recorrido que están entre 1 y 6 casillas por detrás de `cell`. */
function threatsAt(state: GameState, player: Player, cell: number): number {
  let threats = 0;
  for (const enemy of state.players) {
    if (enemy.id === player.id) continue;
    for (const piece of enemy.pieces) {
      if (!isOnMainTrack(piece)) continue;
      const behind = ahead(getRealBoardPosition(enemy.color, piece.steps), cell);
      if (behind >= 1 && behind <= 6) threats++;
    }
  }
  return threats;
}

/** Fichas rivales capturables (recorrido, casilla no segura) entre 1 y 6 casillas por delante de `cell`. */
function targetsFrom(state: GameState, player: Player, cell: number): number {
  let targets = 0;
  for (const enemy of state.players) {
    if (enemy.id === player.id) continue;
    for (const piece of enemy.pieces) {
      if (!isOnMainTrack(piece)) continue;
      const target = getRealBoardPosition(enemy.color, piece.steps);
      if (isSafeCell(target)) continue;
      const distance = ahead(cell, target);
      if (distance >= 1 && distance <= 6) targets++;
    }
  }
  return targets;
}

/**
 * Puntuación de mover `pieceIndex` (simulado con el motor) con el perfil `strategy`
 * (por defecto, el del jugador en turno). `-Infinity` si el motor rechaza la jugada.
 */
export function scoreMove(state: GameState, pieceIndex: number, strategy: StrategyProfile = getStrategy(state.turn)): number {
  const result = applyAction(state, { type: "move", playerId: state.turn, pieceIndex });
  if (!result.ok) return Number.NEGATIVE_INFINITY;

  const moved = result.events.find(
    (e): e is Extract<GameEvent, { type: "piece_moved" }> => e.type === "piece_moved",
  );
  if (!moved) return Number.NEGATIVE_INFINITY;

  const w = (criterion: StrategyCriterion) => AI_WEIGHTS[criterion] * strategy.multipliers[criterion];
  const player = result.state.players.find((p) => p.id === state.turn)!;
  const piece = player.pieces[pieceIndex];
  let score = 0;

  if (result.events.some((e) => e.type === "piece_captured")) score += w("capture");
  if (result.events.some((e) => e.type === "piece_reached_goal")) score += w("reachGoal");
  if (moved.from.state === "base") score += w("leaveBase");
  if (moved.from.state === "track" && moved.to.state === "final") score += w("enterFinalStretch");
  score += moved.distance * w("progressPerStep");

  // Riesgo, seguridad y caza solo cuentan en el recorrido común (en el pasillo nadie captura).
  if (isOnMainTrack(piece)) {
    const cell = getRealBoardPosition(player.color, piece.steps);
    if (isSafeCell(cell)) {
      score += w("landOnSafeCell");
    } else {
      score += threatsAt(result.state, player, cell) * w("threatPerEnemy");
      const partners = player.pieces.filter(
        (p, i) => i !== pieceIndex && isOnMainTrack(p) && getRealBoardPosition(player.color, p.steps) === cell,
      ).length;
      if (partners > 0) score += w("blockade");
    }
    score += targetsFrom(result.state, player, cell) * w("huntPerTarget");
  }
  return score;
}

/**
 * Jugadas candidatas: las que puntúan como mucho `randomness` (fracción) por debajo de la mejor.
 * El margen se calcula sobre |mejor|, así que funciona con puntuaciones negativas; con la mejor en 0
 * solo entran los empates. Se devuelven en orden de índice (reproducible).
 */
export function candidateMoves(scored: ReadonlyArray<{ index: number; score: number }>, randomness: number): number[] {
  const finite = scored.filter((s) => Number.isFinite(s.score));
  if (finite.length === 0) return [];
  const best = Math.max(...finite.map((s) => s.score));
  const margin = Math.max(0, Math.min(randomness, 1)) * Math.abs(best);
  return finite
    .filter((s) => s.score >= best - margin)
    .map((s) => s.index)
    .sort((a, b) => a - b);
}

/**
 * Ficha elegida entre los movimientos legales.
 * - Solo se consideran los índices que además devuelve `getAvailableMoves(state)`.
 * - Sin azar: la mejor puntuación; los empates se resuelven por el índice más bajo.
 * - Con azar (y `random`): una al azar entre `candidateMoves`.
 * Lanza un error si ninguno de los índices es legal.
 */
export function chooseMove(state: GameState, legalMoves: readonly number[], options: ChooseOptions = {}): number {
  const strategy = options.strategy ?? getStrategy(state.turn);
  const available = new Set(getAvailableMoves(state));
  const legal = [...new Set(legalMoves)].filter((i) => available.has(i));
  if (legal.length === 0) throw new Error("No hay movimientos legales entre los indicados");

  const scored = legal.map((index) => ({ index, score: scoreMove(state, index, strategy) }));

  if (strategy.randomness > 0 && options.random) {
    const candidates = candidateMoves(scored, strategy.randomness);
    if (candidates.length > 0) {
      const r = options.random();
      const pick = Number.isFinite(r) ? Math.min(candidates.length - 1, Math.max(0, Math.floor(r * candidates.length))) : 0;
      return candidates[pick];
    }
  }

  let best = legal[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const { index, score } of scored) {
    if (score > bestScore || (score === bestScore && index < best)) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Siguiente acción del jugador en turno.
 * - Sin dado ni bonus pendiente: tirar (el valor lo da `rollDie`, en el servidor crypto.randomInt).
 * - Con dado o bonus: mover la ficha elegida con el perfil del personaje en turno
 *   (`random` solo afecta a los perfiles con azar).
 * - Con dado o bonus pero sin movimientos legales (el motor no debería llegar a ese estado):
 *   `timeout`, que pasa el turno según las reglas, para que la partida nunca se bloquee.
 */
export function decideAction(state: GameState, rollDie: () => number, random?: RandomSource): GameAction {
  if (state.status !== "playing") throw new Error("La partida ha terminado");
  if (state.dice === null && state.pendingBonus === null) {
    return { type: "roll", playerId: state.turn, value: rollDie() };
  }
  const moves = getAvailableMoves(state);
  if (moves.length === 0) return { type: "timeout" };
  return { type: "move", playerId: state.turn, pieceIndex: chooseMove(state, moves, { random }) };
}

/** Generador reproducible (mulberry32) en [0, 1), para pruebas y simulaciones con semilla. */
export function createSeededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
