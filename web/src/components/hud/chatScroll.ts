// Conserva la posición de lectura del chat cuando llegan mensajes (sin React; lo usa ChatScroll).
// El contenedor es `flex-col-reverse`: el scroll empieza abajo (scrollTop 0) y sube con valores
// negativos. Con el scroll abajo, los mensajes nuevos se ven solos en todos los navegadores.
// Si el espectador ha subido a leer, Chrome y Firefox mantienen lo que se lee gracias al anclaje de
// scroll de CSS, pero WebKit (Safari) no lo implementa y el contenido salta (medido en WebKitGTK).
// Por eso: antes del cambio se anota el primer mensaje visible y su posición; después, si se ha
// movido, se compensa. Si el navegador ya lo compensó, la diferencia es 0 y no se hace nada.

export interface ChatScrollAnchor {
  /** `data-chat-key` del primer mensaje visible. */
  key: string;
  /** Distancia de su borde superior al del contenedor. */
  offset: number;
  /** El espectador está abajo del todo (siguiendo los mensajes nuevos). */
  atBottom: boolean;
}

/** Margen (px) para considerar que el scroll está abajo del todo. */
const BOTTOM_TOLERANCE = 2;

export function captureChatAnchor(container: HTMLElement): ChatScrollAnchor | null {
  const box = container.getBoundingClientRect();
  const atBottom = Math.abs(container.scrollTop) < BOTTOM_TOLERANCE;
  for (const item of container.querySelectorAll<HTMLElement>("[data-chat-key]")) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > box.top + 1) return { key: item.dataset.chatKey!, offset: rect.top - box.top, atBottom };
  }
  return null;
}

/** Devuelve el desplazamiento aplicado (0 si no hacía falta). */
export function restoreChatAnchor(container: HTMLElement, anchor: ChatScrollAnchor | null): number {
  // Abajo (según lo anotado o según el estado actual, por si el evento `scroll` de la vuelta abajo
  // aún no se ha procesado): `flex-col-reverse` ya muestra el mensaje nuevo; no se toca nada.
  if (!anchor || anchor.atBottom || Math.abs(container.scrollTop) < BOTTOM_TOLERANCE) return 0;
  const item = container.querySelector<HTMLElement>(`[data-chat-key="${CSS.escape(anchor.key)}"]`);
  if (!item) return 0;
  const delta = item.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) < 0.5) return 0;
  container.scrollTop += delta;
  return delta;
}
