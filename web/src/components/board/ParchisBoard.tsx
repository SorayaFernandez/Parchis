import { BOARD_SIZE } from "@/lib/board/geometry";
import { layoutPieces } from "@/lib/board/layout";
import type { GameState } from "@/lib/engine";
import { cn } from "@/lib/utils";
import { BoardLayers } from "./BoardLayers";
import { BoardPiece } from "./BoardPiece";

interface ParchisBoardProps {
  /** Estado a dibujar: el del motor o, durante una animación, el de un fotograma. */
  state: GameState;
  /** Índices de las fichas del jugador en turno que se resaltan (p. ej. `getAvailableMoves(state)`). */
  highlightedPieces?: readonly number[];
  /** Ficha que se está moviendo (ver `AnimationFrame.movingKey`). */
  movingKey?: string | null;
  /** Duración de la transición hasta la posición actual (la del fotograma en curso). */
  transitionMs?: number;
  className?: string;
}

/**
 * Tablero de solo lectura: dibuja el estado que recibe. No contiene reglas ni estado propio,
 * así que funciona como Server Component o dentro de un Client Component.
 */
export function ParchisBoard({
  state,
  highlightedPieces = [],
  movingKey = null,
  transitionMs = 300,
  className,
}: ParchisBoardProps) {
  const pieces = layoutPieces(state, { movingKey });

  return (
    <svg
      viewBox={`0 0 ${BOARD_SIZE} ${BOARD_SIZE}`}
      role="img"
      aria-label="Tablero de Parchís"
      className={cn("block aspect-square h-auto w-full select-none", className)}
    >
      <BoardLayers />
      <g>
        {pieces.map((piece) => (
          <BoardPiece
            key={piece.key}
            piece={piece}
            moving={piece.key === movingKey}
            transitionMs={transitionMs}
            highlighted={
              piece.playerId === state.turn && highlightedPieces.includes(piece.pieceIndex)
            }
          />
        ))}
      </g>
    </svg>
  );
}
