// Carga inicial del chat para la página /partida/[id]. Nunca lanza: si falla, la partida se muestra
// igual con el chat vacío (el navegador lo recupera después con GET /api/games/[id]/messages).

import "server-only";

import { z } from "zod";
import { CHAT_LIMITS } from "./config";
import { logChatError } from "./log";
import type { ChatMessage } from "./schemas";
import { getChatStore, type ChatStore } from "./store";

export interface InitialChat {
  messages: ChatMessage[];
  /** Quedan versiones pendientes de procesar (el navegador consultará hasta que se procesen). */
  pending: boolean;
}

export async function loadChatMessages(gameId: string, store?: ChatStore): Promise<InitialChat> {
  if (!z.uuid().safeParse(gameId).success) return { messages: [], pending: false };
  try {
    const s = store ?? getChatStore();
    // En este orden, no en paralelo: `chat_commit` inserta los mensajes y vacía la cola en la misma
    // transacción. Si al mirar la cola ya no hay pendientes, la lectura posterior ve sus mensajes.
    // En paralelo, un lote confirmado entre las dos lecturas daría "sin mensaje y sin pendientes", y
    // una partida terminada no activaría el chat (se perdería, p. ej., el último comentario).
    const pending = await s.pending(gameId);
    const messages = await s.latest(gameId, CHAT_LIMITS.initialMessages);
    return { messages, pending };
  } catch (error) {
    logChatError("carga inicial", error);
    // Si no se sabe, se da por pendiente: el navegador lo comprobará con GET (que recupera la cola).
    return { messages: [], pending: true };
  }
}
