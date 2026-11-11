// El chat se ejecuta después de responder (after) y ningún fallo suyo sale de ahí.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const afterMock = vi.fn<(task: () => unknown) => void>();
vi.mock("next/server", () => ({ after: (task: () => unknown) => afterMock(task) }));

const claim = vi.fn();
vi.mock("../store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../store")>();
  return { ...original, getChatStore: () => ({ claim, commit: vi.fn(), release: vi.fn() }) };
});

const { scheduleDrain, runDrainInBackground, chatWriters } = await import("../schedule");
const { logChatError } = await import("../log");
const { ChatStoreError } = await import("../store");

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

describe("scheduleDrain / runDrainInBackground", () => {
  beforeEach(() => {
    afterMock.mockReset();
    claim.mockReset();
    vi.restoreAllMocks();
  });

  it("programa el procesador con after() y no lo ejecuta antes de la respuesta", async () => {
    scheduleDrain(GAME);
    expect(afterMock).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    claim.mockResolvedValue(null);
    await afterMock.mock.calls[0][0](); // la tarea programada vacía la cola de esa partida
    expect(claim.mock.calls[0][0]).toBe(GAME);
  });

  it("si after() no se puede usar, lo registra y no lanza", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    afterMock.mockImplementation(() => {
      throw new Error("after was called outside a request scope");
    });
    expect(() => scheduleDrain(GAME)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[chat] programar"));
  });

  it("con la BD caída: no lanza y registra solo tipo y código", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    claim.mockRejectedValue(new ChatStoreError("database", "Error de base de datos al reservar el chat", "42P01"));
    await expect(runDrainInBackground(GAME)).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toMatch(/^\[chat\] procesador: database \(42P01\)/);
  });

  it("el mismo error se registra como mucho una vez por minuto", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new ChatStoreError("database", "x", "08006");
    logChatError("prueba", error, 1_000_000);
    logChatError("prueba", error, 1_030_000);
    logChatError("prueba", error, 1_061_000);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("chatWriters (escritor LLM o local según las variables)", () => {
  const KEY = "clave-secreta-de-prueba-123";
  const enabled = { CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, CHAT_LLM_MODEL: "nvidia/nemotron-3.5-lightning-free" };
  const request = (important: boolean) => ({
    utterance: { speaker: "ai-pink", kind: "goal" as const, rival: null, trigger: "goal" as const, replyTo: null, important },
    recent: [],
    replyToText: null,
  });

  beforeEach(() => vi.unstubAllGlobals());

  it("sin activar (lo normal hoy): todo con el escritor local y sin registrar nada", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { writer, fallbackWriter } = chatWriters({});
    expect(writer).toBe(fallbackWriter);
    expect(log).not.toHaveBeenCalled();
  });

  it("activo y bien configurado: lo importante llama a AI Gateway; lo demás, no", async () => {
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "¡Meta para Brava, sin despeinarse!" } }] }));
    vi.stubGlobal("fetch", fetch);
    const { writer, fallbackWriter } = chatWriters(enabled);
    expect(writer).not.toBe(fallbackWriter);
    expect(await writer.write(request(false))).toMatchObject({ source: "local" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await writer.write(request(true))).toMatchObject({ source: "llm" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("mal configurado (p. ej. modelo no permitido o clave pública): local y un registro sin la clave", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ ...enabled, CHAT_LLM_MODEL: "openai/gpt-5" }, { ...enabled, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY }]) {
      const { writer, fallbackWriter } = chatWriters(env);
      expect(writer).toBe(fallbackWriter);
    }
    const output = log.mock.calls.flat().join(" ");
    expect(output).toMatch(/model_not_allowed/);
    expect(output).toMatch(/public_secret/);
    expect(output).not.toContain(KEY);
  });
});
