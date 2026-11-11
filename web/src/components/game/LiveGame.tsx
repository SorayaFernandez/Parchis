"use client";

import { applyPositions } from "@/lib/board/animation";
import type { GameResponse } from "@/lib/game/api";
import { GameView } from "./GameView";
import { useLiveGame } from "./useLiveGame";

/**
 * Partida en directo. Recibe la partida leída en el servidor (el HTML inicial ya la trae) y,
 * mientras está montada, la hace avanzar y la mantiene sincronizada con Realtime.
 */
export function LiveGame({ initial }: { initial: GameResponse }) {
  const { view, frame } = useLiveGame(initial);
  const { display } = view;

  return (
    <GameView
      game={display}
      live={{
        boardState: frame ? applyPositions(display.state, frame.positions) : display.state,
        movingKey: frame?.movingKey ?? null,
        transitionMs: frame?.durationMs,
        animating: view.animation !== null,
        rollKey: view.lastRollVersion,
        log: view.log,
        connection: view.connection,
      }}
    />
  );
}
