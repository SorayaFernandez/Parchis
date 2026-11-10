import { useEffect, useRef, useState } from "react";
import type { Point } from "../board/boardCoordinates";
import { mainTrack, bases, CENTER } from "../board/boardCoordinates";

type Params = {
  piece: any;
  player: any;
  pieceIndex: number;
};

export function useAnimatedPiece({
  piece,
  player,
  pieceIndex,
}: Params) {
  const animationRef = useRef<number | null>(null);

  function getPosition(): Point {
    if (piece.state === "base") {
      return (
        bases[player.color]?.[pieceIndex] ??
        CENTER
      );
    }

    if (piece.state === "track") {
      return (
        mainTrack[piece.trackIndex] ??
        CENTER
      );
    }

    if (piece.state === "home") {
      return CENTER;
    }

    return CENTER;
  }

  const [position, setPosition] = useState<Point>(
    getPosition()
  );

  useEffect(() => {
    const target = getPosition();

    animate(position, target);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [
    piece.state,
    piece.trackIndex,
    piece.position,
    pieceIndex,
  ]);

  function animate(
    from: Point,
    to: Point
  ) {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    const start = performance.now();
    const duration = 280;

    function frame(now: number) {
      const t = Math.min(
        (now - start) / duration,
        1
      );

      const eased =
        1 - Math.pow(1 - t, 3);

      const x =
        from.x + (to.x - from.x) * eased;

      const y =
        from.y + (to.y - from.y) * eased;

      setPosition({ x, y });

      if (t < 1) {
        animationRef.current =
          requestAnimationFrame(frame);
      }
    }

    animationRef.current =
      requestAnimationFrame(frame);
  }

  return position;
}