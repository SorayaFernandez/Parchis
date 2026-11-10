import { useEffect, useRef } from "react";

export function usePieceAnimation() {
  const frame = useRef<number | null>(null);

  const animate = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    onUpdate: (p: { x: number; y: number }) => void,
    duration = 300
  ) => {
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);

      const eased = t * (2 - t); 

      onUpdate({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });

      if (t < 1) {
        frame.current = requestAnimationFrame(step);
      }
    };

    frame.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  return { animate };
}