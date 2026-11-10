import GameBoard from "../board/GameBoard";
import GamePieces from "../pieces/GamePieces";
import BoardEffects from "../board/BoardEffects";

export default function GameScene({
  game,
  onPieceClick,
}: any) {
  return (
    <div className="relative w-full h-screen overflow-hidden">

      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,.12),transparent_60%)]" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-square w-[92vmin] max-w-[1100px]">
            <GameBoard />
            <BoardEffects />
            <GamePieces
              game={game}
              onPieceClick={onPieceClick}
            />
        </div>
      </div>
    </div>
  );
}