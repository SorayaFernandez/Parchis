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

const { scheduleDrain, runDrainInBackground } = await import("../schedule");
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
