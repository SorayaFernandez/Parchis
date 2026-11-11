// Pone en marcha el procesador del chat DESPUÉS de enviar una respuesta (`after` de Next.js).
// No es el único mecanismo: las versiones ya están en la cola (las encola PostgreSQL al confirmar
// el avance), así que cualquier ejecución posterior las recoge — el siguiente avance, el GET de
// mensajes de cualquier espectador (que lo lanza si hay pendientes) o una llamada manual.
// Nunca lanza: un fallo del chat no afecta a la respuesta ni a la partida.

import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { after } from "next/server";
import { readChatLlmConfig } from "./llm/env";
import { createGatewayWriter, createImportantOnlyWriter, createLlmBreaker } from "./llm/gatewayWriter";
import { logChatError } from "./log";
import { drainChat } from "./service";
import { getChatStore } from "./store";
import { createLocalWriter, type ChatWriter } from "./writer";

const random = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** Corte temporal del LLM, compartido por todas las ejecuciones del proceso. */
const llmBreaker = createLlmBreaker();

/**
 * Escritores del procesador. El local es siempre la reserva. Si el LLM está activo y bien
 * configurado (`CHAT_LLM_ENABLED=true`, clave y modelo permitido), las intervenciones importantes
 * las escribe el LLM y el resto el local; si no, todo lo escribe el local.
 */
export function chatWriters(env: Readonly<Record<string, string | undefined>> = process.env): { writer: ChatWriter; fallbackWriter: ChatWriter } {
  const local = createLocalWriter(random);
  const config = readChatLlmConfig(env);
  if (!config.enabled) {
    // `off` es lo normal; los demás motivos son errores de configuración (se registran sin valores).
    if (config.reason !== "off") logChatError("configuración del LLM", Object.assign(new Error(config.reason), { name: `LLM ${config.reason}` }));
    return { writer: local, fallbackWriter: local };
  }
  const llm = createGatewayWriter({
    config,
    fetch: (...args) => fetch(...args),
    breaker: llmBreaker,
    onFailure: (error) => logChatError("escritor LLM", error),
  });
  return { writer: createImportantOnlyWriter(llm, local), fallbackWriter: local };
}

/** Vacía la cola del chat de la partida. Nunca lanza. */
export async function runDrainInBackground(gameId: string): Promise<void> {
  try {
    const { writer, fallbackWriter } = chatWriters();
    const result = await drainChat(gameId, {
      store: getChatStore(),
      writer,
      fallbackWriter,
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
