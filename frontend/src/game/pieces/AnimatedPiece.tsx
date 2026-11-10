import Piece from "./Piece";
import { useAnimatedPiece } from "../hooks/useAnimatedPiece";

type Props = {
  piece: any;
  player: any;
  pieceIndex: number;
};

export default function AnimatedPiece({
  piece,
  player,
  pieceIndex,
}: Props) {
  const pos = useAnimatedPiece({
    piece,
    player,
    pieceIndex,
  });

  return (
    <svg
      className="
        absolute
        inset-0
        w-full
        h-full
        overflow-visible
      "
    >
      <Piece
        x={pos.x}
        y={pos.y}
        color={player.color}
      />
    </svg>
  );
}