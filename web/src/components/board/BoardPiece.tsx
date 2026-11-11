import { COLOR_HEX, COLOR_LABEL, PIECE_IMAGES, PIECE_IMAGE_SCALE } from "@/lib/board/geometry";
import type { BoardSlot, PieceLayout } from "@/lib/board/layout";

function describeSlot(slot: BoardSlot): string {
  switch (slot.kind) {
    case "base":
      return "en casa";
    case "goal":
      return "en la meta";
    case "track":
      return `en la casilla ${slot.cell}`;
    case "stretch":
      return `en el pasillo final (${slot.index + 1} de 7)`;
  }
}

interface BoardPieceProps {
  piece: PieceLayout;
  highlighted?: boolean;
  /** Se está moviendo casilla a casilla: velocidad constante para encadenar los saltos. */
  moving?: boolean;
  /** Duración de la transición hasta la posición actual. */
  transitionMs?: number;
}

/** Ficha: halo de color + imagen del original con sombra (como GamePieces.tsx). */
export function BoardPiece({ piece, highlighted = false, moving = false, transitionMs = 300 }: BoardPieceProps) {
  const color = COLOR_HEX[piece.color];
  const half = piece.size / 2;
  // Se compensa el margen transparente del PNG para que la ficha visible mida `piece.size`.
  const imageSize = piece.size * PIECE_IMAGE_SCALE;

  return (
    <g
      className="transition-transform motion-reduce:transition-none"
      style={{
        transform: `translate(${piece.x}px, ${piece.y}px)`,
        transitionDuration: `${transitionMs}ms`,
        transitionTimingFunction: moving ? "linear" : "ease-out",
      }}
    >
      <title>{`Ficha ${piece.pieceIndex + 1} ${COLOR_LABEL[piece.color]}, ${describeSlot(piece.slot)}`}</title>
      {highlighted && (
        <circle
          r={half + 10}
          fill="none"
          stroke="white"
          strokeWidth={4}
          className="animate-pulse"
        />
      )}
      <circle r={half + 6} fill={color} opacity={0.18} />
      <image
        href={PIECE_IMAGES[piece.color]}
        x={-imageSize / 2}
        y={-imageSize / 2}
        width={imageSize}
        height={imageSize}
        style={{ filter: `drop-shadow(0 0 8px ${color})` }}
      />
    </g>
  );
}
