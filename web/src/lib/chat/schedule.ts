// Pone en marcha el procesador del chat DESPUÉS de enviar una respuesta (`after` de Next.js).
// No es el único mecanismo: las versiones ya están en la cola (las encola PostgreSQL al confirmar
// el avance), así que cualquier ejecución posterior las recoge — el siguiente avance, el GET de
// mensajes de cualquier espectador (que lo lanza si hay pendientes) o una llamada manual.
// Nunca lanza: un fallo del chat no afecta a la respuesta ni a la partida.

import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { after } from "next/server";
import { logChatError } from "./log";
import { drainChat } from "./service";
import { getChatStore } from "./store";
import { createLocalWriter } from "./writer";

const random = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** Vacía la cola del chat de la partida. Nunca lanza. */
export async function runDrainInBackground(gameId: string): Promise<void> {
  try {
    const writer = createLocalWriter(random);
    const result = await drainChat(gameId, {
      store: getChatStore(),
      writer,
      fallbackWriter: writer,
      random,
      newToken: randomUUID,
    });
    if (result.kind === "error") logChatError("procesador", result.error);
  } catch (error) {
    logChatError("procesador", error);
  }
}

/** Programa el procesador tras la respuesta. Si no se puede programar, se registra y nada más. */
export function scheduleDrain(gameId: string): void {
  try {
    after(() => runDrainInBackground(gameId));
  } catch (error) {
    logChatError("programar", error);
  }
}
