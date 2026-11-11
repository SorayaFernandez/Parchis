// Modelo puro del chat en el navegador: mensajes recibidos (sin duplicados y en orden) y cuáles se
// pueden mostrar según la versión que el tablero ya ha terminado de dibujar.

import type { ChatMessage } from "./schemas";

/** Mensajes que se conservan en memoria (la partida tiene como mucho 60). */
export const FEED_LIMIT = 100;

/** Orden de la conversación: por versión y, dentro de ella, mensaje antes que réplica. */
const byConversation = (a: ChatMessage, b: ChatMessage) => a.version - b.version || a.seq - b.seq || a.id - b.id;

/** Añade mensajes sin duplicar (por id). Devuelve el mismo array si no hay nada nuevo. */
export function mergeMessages(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): readonly ChatMessage[] {
  const known = new Set(current.map((m) => m.id));
  const fresh: ChatMessage[] = [];
  for (const message of incoming) {
    if (known.has(message.id)) continue;
    known.add(message.id);
    fresh.push(message);
  }
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort(byConversation).slice(-FEED_LIMIT);
}

/** Mayor id recibido (cursor para recuperar los posteriores). */
export const maxMessageId = (messages: readonly ChatMessage[], previous = 0) =>
  messages.reduce((max, m) => Math.max(max, m.id), previous);

/** Mensajes de acontecimientos que el tablero ya ha mostrado. */
export const visibleMessages = (messages: readonly ChatMessage[], boardVersion: number) =>
  messages.filter((m) => m.version <= boardVersion);
