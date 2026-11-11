// Carga inicial del chat (B2): nunca devuelve "sin el último mensaje y sin pendientes" aunque el
// último lote se confirme justo durante la carga.

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../schemas";
import type { ChatStore } from "../store";

vi.mock("server-only", () => ({}));
const { loadChatMessages } = await import("../load");

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const victory: ChatMessage = {
  id: 9, version: 640, seq: 0, characterId: "ai-green", trigger: "finish_place", replyToSeq: null, text: "Fin para mí.", createdAt: "",
};

/** Almacén con un lote pendiente que se confirma (atómicamente) justo después de la primera lectura. */
function racingStore() {
  let committed = false;
  const calls: string[] = [];
  const afterFirstRead = () => {
    if (calls.length === 1) committed = true; // el procesador confirma entre las dos lecturas
  };
  const store = {
    async pending() {
      calls.push("pending");
      const value = !committed;
      afterFirstRead();
      return value;
    },
    async latest() {
      calls.push("latest");
      const value = committed ? [victory] : [];
      afterFirstRead();
      return value;
    },
  } as unknown as ChatStore;
  return { store, calls };
}

describe("loadChatMessages (B2)", () => {
  it("mira la cola antes que los mensajes, así que nunca pierde el lote que se confirma durante la carga", async () => {
    const { store, calls } = racingStore();
    const result = await loadChatMessages(GAME, store);
    expect(calls).toEqual(["pending", "latest"]);
    // O el mensaje ya está, o queda marcado como pendiente (el navegador lo recogerá). Nunca ninguno.
    expect(result.messages.length > 0 || result.pending).toBe(true);
    expect(result).toEqual({ messages: [victory], pending: true });
  });

  it("si falla la lectura, se da por pendiente (el navegador lo comprobará) y no lanza", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = { pending: async () => { throw new Error("red"); }, latest: async () => [] } as unknown as ChatStore;
    expect(await loadChatMessages(GAME, store)).toEqual({ messages: [], pending: true });
  });

  it("id no válido: vacío sin consultar", async () => {
    const { store, calls } = racingStore();
    expect(await loadChatMessages("no-es-uuid", store)).toEqual({ messages: [], pending: false });
    expect(calls).toEqual([]);
  });
});
