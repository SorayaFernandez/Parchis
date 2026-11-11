"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LiveChatController } from "@/lib/chat/chatController";
import { visibleMessages } from "@/lib/chat/feed";
import type { ChatMessage } from "@/lib/chat/schemas";
import { subscribeToChat } from "./realtime";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Chat en directo: mensajes iniciales (del servidor) + Realtime + recuperación tras cortes.
 * Devuelve solo los mensajes de versiones que el tablero ya ha mostrado (`boardVersion`).
 * Sigue suscrito tras el final de la partida (hasta desmontar) para recibir los mensajes de la victoria.
 */
export function useLiveChat(
  gameId: string,
  initial: readonly ChatMessage[],
  boardVersion: number,
  /** `false` para una partida que ya estaba terminada (y sin pendientes) al abrirla: solo los iniciales. */
  enabled: boolean,
  /** La partida ha terminado: si quedan versiones pendientes, se consulta hasta que se procesen. */
  finished: boolean,
) {
  const [controller] = useState(
    () =>
      new LiveChatController(gameId, initial, {
        fetch: (...args) => fetch(...args),
        subscribe: subscribeToChat,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);

  useEffect(() => {
    if (!enabled) return;
    controller.start();
    return () => controller.stop();
  }, [controller, enabled]);

  useEffect(() => controller.setFinished(finished), [controller, finished]);

  // Al volver a la pestaña (no al montar: ya lo hace la suscripción) o recuperar la red: pedir lo perdido.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) controller.resync();
    wasVisible.current = visible;
  }, [controller, visible]);
  useEffect(() => {
    const onOnline = () => controller.resync();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [controller]);

  return useMemo(() => visibleMessages(view.messages, boardVersion), [view.messages, boardVersion]);
}
