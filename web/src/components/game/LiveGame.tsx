"use client";

import { applyPositions } from "@/lib/board/animation";
import type { ChatMessage } from "@/lib/chat/schemas";
import type { GameResponse } from "@/lib/game/api";
import { GameView } from "./GameView";
import { useLiveChat } from "./useLiveChat";
import { useLiveGame } from "./useLiveGame";

/**
 * Partida en directo. Recibe la partida leída en el servidor (el HTML inicial ya la trae) y,
 * mientras está montada, la hace avanzar y la mantiene sincronizada con Realtime.
 */
export function LiveGame({
  initial,
  initialMessages,
  chatPending = false,
}: {
  initial: GameResponse;
  initialMessages: readonly ChatMessage[];
  chatPending?: boolean;
}) {
  const { view, frame } = useLiveGame(initial);
  const { display } = view;
  // Chat: solo mensajes de versiones que el tablero ya ha terminado de dibujar.
  // Activo si la partida está en curso o si, ya terminada, quedan versiones del chat por procesar.
  const chat = useLiveChat(
    initial.id,
    initialMessages,
    view.boardVersion,
    initial.status !== "finished" || chatPending,
    view.latest.status === "finished",
  );

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
      chat={chat}
    />
  );
}
