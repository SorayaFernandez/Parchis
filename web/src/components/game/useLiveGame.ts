"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { buildAnimation } from "@/lib/board/animation";
import type { GameResponse } from "@/lib/game/api";
import { LiveGameController } from "@/lib/game/liveController";
import { useBoardAnimation, usePrefersReducedMotion } from "@/components/board/useBoardAnimation";
import { subscribeToGame } from "./realtime";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Partida en directo: crea el controlador (avance + Realtime) mientras el componente está montado
 * y reproduce con `useBoardAnimation` las animaciones de cada versión nueva.
 * Al desmontar (salir de la página, o página oculta por <Activity>) se detiene todo.
 */
export function useLiveGame(initial: GameResponse) {
  const [controller] = useState(
    () =>
      new LiveGameController(initial, {
        fetch: (...args) => fetch(...args),
        subscribe: subscribeToGame,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
  const reducedMotion = usePrefersReducedMotion();
  const { frame, animating, play } = useBoardAnimation();
  /** Paso que se está animando (no afecta al render: ref). */
  const playing = useRef<number | null>(null);

  // Ciclo de vida: empezar al montar, detener al desmontar.
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => controller.setVisible(visible), [controller, visible]);

  // Red recuperada (evento del navegador): ponerse al día sin esperar al reintento.
  useEffect(() => {
    const onOnline = () => controller.networkRestored();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [controller]);

  // Nuevo paso: animarlo (o avisar de que no hay nada que animar).
  const animation = view.animation;
  useEffect(() => {
    if (!animation) return;
    const frames =
      animation.step.kind === "animate" && !reducedMotion
        ? buildAnimation(animation.step.from.state, animation.step.to.lastEvents, animation.step.to.state)
        : [];
    if (frames.length === 0) {
      controller.animationDone(animation.seq);
      return;
    }
    playing.current = animation.seq;
    play(frames);
  }, [animation, controller, play, reducedMotion]);

  // Fin de la animación en curso (`animating` pasa a false tras el último fotograma).
  useEffect(() => {
    if (playing.current !== null && !animating) {
      const seq = playing.current;
      playing.current = null;
      controller.animationDone(seq);
    }
  }, [animating, controller]);

  return { view, frame };
}
