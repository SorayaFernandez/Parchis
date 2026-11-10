import type { Game } from "../../types/game";
import {bases, finishedPositions} from "../boardPositions";

const pieceImages: Record<string, string> = {
  pink: "/pieces/pink-piece.png",
  purple: "/pieces/purple-piece.png",
  blue: "/pieces/blue-piece.png",
  green: "/pieces/green-piece.png",
};

type PieceRenderData = {
  playerId: number;
  color: string;
  index: number;
  position: number;
  x: number;
  y: number;
};

const STACK_OFFSET = 60;

const VERTICAL_TRACK = new Set([
  1, 2, 3, 4, 5, 6, 7, 8,
  26, 27, 28, 29, 30, 31, 32, 33,
  34,
  35, 36, 37, 38, 39, 40, 41, 42,
  
  60, 61, 62, 63, 64, 65, 66, 67, 68,
]);

export default function GamePieces({
  game,
  onPieceClick,
}: {
  game: Game;
  onPieceClick: (
    playerId: number,
    pieceIndex: number
  ) => void;
}) {
  const piecesToRender: PieceRenderData[] = [];

  for (const player of game.players) {
    player.pieces.forEach((piece, i) => {
      let pos = piece.coords;

      if (!pos && piece.state === "base") {
        pos = bases[player.color][i];
      }

      if (!pos && piece.state === "finished") {
        pos = finishedPositions[player.color][i];
      }

      if (!pos) return;

      piecesToRender.push({
        playerId: player.id,
        color: player.color,
        index: i,
        position: piece.position,
        x: pos.x,
        y: pos.y,
      });
    });
  }

  const groups = new Map<string, PieceRenderData[]>();

  for (const piece of piecesToRender) {

    const key = `${Math.round(piece.x)}-${Math.round(piece.y)}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key)!.push(piece);
  }

  const finalPieces: PieceRenderData[] = [];

  groups.forEach((group) => {
    if (group.length === 1) {
      finalPieces.push(group[0]);
      return;
    }

    groups.forEach((group) => {
      if (group.length === 1) {
        finalPieces.push(group[0]);
        return;
      }

      const baseX = group[0].x;
      const baseY = group[0].y;
      const trackPos = group[0].position;

      const isFinalStretch = group.every((piece) => {
        const player = game.players.find(
          (p) => p.id === piece.playerId
        );

        return (
          player?.pieces[piece.index].state ===
          "final"
        );
      });

      let isVerticalTrack: boolean;

      if (isFinalStretch) {

        const color = group[0].color;

        isVerticalTrack =
          color === "green" ||
          color === "blue";
      } else {

        isVerticalTrack =
          VERTICAL_TRACK.has(trackPos);
      }

      const center = (group.length - 1) / 2;

      group.forEach((piece, idx) => {
        const offset =
          (idx - center) * STACK_OFFSET;

        if (isVerticalTrack) {
          finalPieces.push({
            ...piece,
            x: baseX + offset,
          });
        } else {
          finalPieces.push({
            ...piece,
            y: baseY + offset,
          });
        }
      });
    });

  });

  return (
    <svg
      viewBox="0 0 1600 1600"
      className="
        absolute
        inset-0
        w-full
        h-full
        z-30
        pointer-events-auto
      "
      preserveAspectRatio="xMidYMid meet"
    >
      {finalPieces.map((piece) => (
        <g
          key={`${piece.playerId}-${piece.index}`}
          onClick={() =>
            onPieceClick(
              piece.playerId,
              piece.index
            )
          }
          style={{
            cursor: "pointer",
            transition:
              "transform 220ms ease-out",
          }}
        >
          <circle
            cx={piece.x}
            cy={piece.y}
            r={42}
            fill={piece.color}
            opacity={0.18}
          />

          <image
            href={pieceImages[piece.color]}
            x={piece.x - 32}
            y={piece.y - 32}
            width={64}
            height={64}
            preserveAspectRatio="xMidYMid meet"
            style={{
              transition:
                "x 220ms ease-out, y 220ms ease-out",
              filter: `
                drop-shadow(0 0 12px ${piece.color})
                drop-shadow(0 0 24px ${piece.color})
              `,
            }}
          />
        </g>
      ))}
    </svg>
  );
}