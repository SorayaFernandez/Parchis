"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { captureChatAnchor, restoreChatAnchor, type ChatScrollAnchor } from "./chatScroll";

/**
 * Contenedor con scroll del chat: `flex-col-reverse` (empieza abajo y sigue los mensajes nuevos sin
 * JS) y, además, conserva la posición de lectura si el espectador ha subido (WebKit/Safari no tiene
 * anclaje de scroll de CSS). `count` cambia con cada mensaje nuevo.
 */
export function ChatScroll({ count, className, children }: { count: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<ChatScrollAnchor | null>(null);

  // Tras cada cambio de mensajes: compensar si hacía falta y anotar la nueva posición.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    restoreChatAnchor(container, anchor.current);
    anchor.current = captureChatAnchor(container);
  }, [count]);

  // Al hacer scroll el espectador, la posición de lectura cambia.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const onScroll = () => {
      anchor.current = captureChatAnchor(container);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div ref={ref} className={cn("flex flex-col-reverse overflow-y-auto overscroll-contain", className)}>
      {children}
    </div>
  );
}
