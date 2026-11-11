"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AnimationFrame } from "@/lib/board/animation";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** `true` si el usuario ha pedido reducir el movimiento (en el servidor, `false`). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

interface Playback {
  frames: readonly AnimationFrame[];
  index: number;
}

const IDLE: Playback = { frames: [], index: 0 };

/**
 * Reproduce los fotogramas de `buildAnimation`: muestra cada uno durante su `durationMs`
 * y pasa al siguiente. Mientras `animating` sea `true` no se deben lanzar nuevas acciones.
 * Con "reducir movimiento" activado no anima: el tablero salta al estado final.
 */
export function useBoardAnimation() {
  const [playback, setPlayback] = useState<Playback>(IDLE);
  const reducedMotion = usePrefersReducedMotion();

  const frame = playback.index < playback.frames.length ? playback.frames[playback.index] : null;

  useEffect(() => {
    if (!frame) return;
    const id = setTimeout(() => setPlayback((p) => ({ ...p, index: p.index + 1 })), frame.durationMs);
    return () => clearTimeout(id);
  }, [frame]);

  const play = useCallback(
    (frames: readonly AnimationFrame[]) => setPlayback(reducedMotion || frames.length === 0 ? IDLE : { frames, index: 0 }),
    [reducedMotion],
  );
  const cancel = useCallback(() => setPlayback(IDLE), []);

  return { frame, animating: frame !== null, play, cancel };
}
