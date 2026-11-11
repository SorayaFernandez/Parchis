import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPageSchema, type ChatMessage } from "@/lib/chat/schemas";

vi.mock("server-only", () => ({}));

const latest = vi.fn();
const after = vi.fn();
const pending = vi.fn();
vi.mock("@/lib/chat/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chat/store")>();
  return { ...original, getChatStore: () => ({ latest, after, pending }) };
});
const scheduleDrain = vi.fn();
vi.mock("@/lib/chat/schedule", () => ({ scheduleDrain: (...args: unknown[]) => scheduleDrain(...args) }));

const { GET } = await import("../route");
const { ChatStoreError } = await import("@/lib/chat/store");

const ID = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const call = (query = "", id = ID) =>
  GET(new Request(`http://localhost/api/games/${id}/messages${query}`), { params: Promise.resolve({ id }) });
const message = (id: number): ChatMessage => ({
  id, version: id, seq: 0, characterId: "ai-green", trigger: "goal", replyToSeq: null, text: "Paso a paso se llega lejos.", createdAt: "2026-11-11T10:00:00Z",
});

describe("GET /api/games/[id]/messages", () => {
  beforeEach(() => {
    latest.mockReset();
    after.mockReset();
    pending.mockReset().mockResolvedValue(false);
    scheduleDrain.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sin `after`: los últimos 20; con `after`: los posteriores, con hasMore; siempre no-store", async () => {
    latest.mockResolvedValue([message(1), message(2)]);
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(ChatPageSchema.parse(await first.json())).toEqual({ messages: [message(1), message(2)], hasMore: false, pending: false });
    expect(latest).toHaveBeenCalledWith(ID, 20);

    after.mockResolvedValue(Array.from({ length: 100 }, (_, i) => message(i + 3)));
    const page = await call("?after=2");
    expect((await page.json()).hasMore).toBe(true);
    expect(after).toHaveBeenCalledWith(ID, 2, 100);
  });

  it("404 si el id no es un UUID y 400 si `after` no es un entero ≥ 0 (sin consultar la BD)", async () => {
    expect((await call("", "no-es-uuid")).status).toBe(404);
    for (const q of ["?after=", "?after=-1", "?after=1.5", "?after=abc"]) {
      const response = await call(q);
      expect(response.status, q).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_query");
    }
    expect(latest).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("503 si falla la BD y 500 si los datos no son válidos, sin detalles", async () => {
    after.mockRejectedValue(new ChatStoreError("database", "Error de base de datos al leer el chat", "42P01"));
    const down = await call("?after=0");
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain("42P01");
    latest.mockRejectedValue(new ChatStoreError("invalid_data", "Mensajes guardados no válidos"));
    expect((await call()).status).toBe(500);
  });

  it("con versiones pendientes: lo indica y pone en marcha el procesador (recuperación sin nuevos avances)", async () => {
    after.mockResolvedValue([]);
    pending.mockResolvedValue(true);
    const response = await call("?after=5");
    expect(await response.json()).toEqual({ messages: [], hasMore: false, pending: true });
    expect(scheduleDrain).toHaveBeenCalledExactlyOnceWith(ID);
    pending.mockResolvedValue(false);
    await call("?after=5");
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });
});
