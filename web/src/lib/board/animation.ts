// Fotogramas de la animación del tablero a partir de los eventos del motor.
// El estado real lo lleva el motor; esto solo describe posiciones visuales temporales.

import type { GameEvent, GameState, PlayerId } from "@/lib/engine";
import { journeySteps, pieceStateForSteps } from "./journey";

/** `steps` visibles de cada ficha, por jugador. */
export type PiecePositions = Readonly<Record<PlayerId, readonly number[]>>;

export interface AnimationFrame {
  positions: PiecePositions;
  /** Ficha que se está moviendo (se dibuja encima y sin apilar), o `null`. */
  movingKey: string | null;
  /** Duración del desplazamiento hasta este fotograma (y tiempo que se muestra). */
  durationMs: number;
}

export const ANIMATION_TIMING = {
  /** Duración de cada casilla en un movimiento corto. */
  hopMs: 170,
  /** Mínimo por casilla (movimientos largos, p. ej. bonus de 20). */
  minHopMs: 55,
  /** Duración máxima total de un movimiento. */
  maxMoveMs: 1500,
  /** Salida de casa a la casilla de salida. */
  exitMs: 320,
  /** Ficha capturada o penalizada volviendo a casa. */
  toBaseMs: 420,
  /** Fotograma final: las fichas se recolocan (apilado) en su posición real. */
  settleMs: 220,
} as const;

export const pieceKey = (playerId: PlayerId, pieceIndex: number) => `${playerId}:${pieceIndex}`;

export function positionsOf(state: GameState): PiecePositions {
  return Object.fromEntries(state.players.map((p) => [p.id, p.pieces.map((piece) => piece.steps)]));
}

function withPiece(positions: PiecePositions, playerId: PlayerId, pieceIndex: number, steps: number): PiecePositions {
  const pieces = [...positions[playerId]];
  pieces[pieceIndex] = steps;
  return { ...positions, [playerId]: pieces };
}

/** Estado para dibujar: el real con las fichas en las posiciones visuales indicadas. */
export function applyPositions(state: GameState, positions: PiecePositions): GameState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      pieces: player.pieces.map((piece, i) => {
        const steps = positions[player.id]?.[i] ?? piece.steps;
        return steps === piece.steps ? piece : { ...piece, steps, state: pieceStateForSteps(steps) };
      }),
    })),
  };
}

/**
 * Convierte los eventos de una acción en fotogramas, partiendo de las posiciones de `prev`.
 * - `piece_moved`: un fotograma por casilla recorrida (salida de casa, recorrido, entrada,
 *   casillas de color y meta), con duración acotada para que los bonus largos no se eternicen.
 * - `piece_captured` / `third_six_penalty`: la ficha vuelve a casa, después del movimiento.
 * - Al final, un fotograma con las posiciones de `next`: la animación siempre acaba en el estado real.
 * Si la acción no mueve ninguna ficha (p. ej. una tirada), devuelve `[]`.
 */
export function buildAnimation(
  prev: GameState,
  events: readonly GameEvent[],
  next: GameState,
  timing: typeof ANIMATION_TIMING = ANIMATION_TIMING,
): AnimationFrame[] {
  const frames: AnimationFrame[] = [];
  let positions = positionsOf(prev);

  const sendToBase = (playerId: PlayerId, pieceIndex: number) => {
    positions = withPiece(positions, playerId, pieceIndex, -1);
    frames.push({ positions, movingKey: pieceKey(playerId, pieceIndex), durationMs: timing.toBaseMs });
  };

  for (const event of events) {
    switch (event.type) {
      case "piece_moved": {
        const hops = journeySteps(event.from.steps, event.to.steps);
        const leavingBase = event.from.steps < 0;
        const hopMs = leavingBase
          ? timing.exitMs
          : Math.max(timing.minHopMs, Math.min(timing.hopMs, Math.floor(timing.maxMoveMs / hops.length)));
        for (const steps of hops) {
          positions = withPiece(positions, event.playerId, event.pieceIndex, steps);
          frames.push({ positions, movingKey: pieceKey(event.playerId, event.pieceIndex), durationMs: hopMs });
        }
        break;
      }
      case "piece_captured":
        sendToBase(event.victimId, event.victimPieceIndex);
        break;
      case "third_six_penalty":
        if (event.pieceIndex !== null) sendToBase(event.playerId, event.pieceIndex);
        break;
      default:
        break;
    }
  }

  if (frames.length > 0) {
    frames.push({ positions: positionsOf(next), movingKey: null, durationMs: timing.settleMs });
  }
  return frames;
}

/** Duración total de una animación. */
export const animationDuration = (frames: readonly AnimationFrame[]) =>
  frames.reduce((sum, f) => sum + f.durationMs, 0);
