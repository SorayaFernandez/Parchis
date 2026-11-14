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

// Limitador global de AI Gateway: un doble controlable (sin red). Existe solo si hay credenciales de Upstash.
const limiterState = vi.hoisted(() => ({ allowed: true, acquired: 0, blocked: [] as number[] }));
vi.mock("@/lib/llm/gatewayLimiter", () => ({
  getGatewayLimiter: (env: Record<string, string | undefined>) =>
    env.UPSTASH_REDIS_REST_URL
      ? {
          acquire: async () => {
            limiterState.acquired++;
            return limiterState.allowed ? { kind: "allowed", grant: null } : { kind: "rate_limited" };
          },
          reportRateLimited: async (ms: number) => void limiterState.blocked.push(ms),
          refundMovesGrant: async () => false,
        }
      : null,
}));

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
  const UPSTASH = { UPSTASH_REDIS_REST_URL: "https://ejemplo.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token-falso-de-upstash" };
  const enabled = { CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, CHAT_LLM_MODEL: "nvidia/nemotron-3.5-lightning-free", ...UPSTASH };
  const request = (important: boolean) => ({
    utterance: { speaker: "ai-pink", kind: "goal" as const, rival: null, trigger: "goal" as const, replyTo: null, important },
    recent: [],
    replyToText: null,
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    limiterState.allowed = true;
    limiterState.acquired = 0;
    limiterState.blocked = [];
  });

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
    expect(limiterState.acquired).toBe(1); // solo lo que va al modelo pide permiso
  });

  it("activo pero sin Upstash: todo local (el LLM exige el limitador global) y un registro sin valores", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { UPSTASH_REDIS_REST_URL: _u, UPSTASH_REDIS_REST_TOKEN: _t, ...withoutUpstash } = enabled;
    const { writer, fallbackWriter } = chatWriters(withoutUpstash);
    expect(writer).toBe(fallbackWriter);
    expect(await writer.write(request(true))).toMatchObject({ source: "local" });
    expect(fetch).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join(" ");
    expect(output).toMatch(/sin_upstash/);
    expect(output).not.toContain(KEY);
  });

  it("sin permiso del limitador global: no se llama al modelo (el servicio usará la frase local)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    limiterState.allowed = false;
    const { writer } = chatWriters(enabled);
    await expect(writer.write(request(true))).rejects.toMatchObject({ kind: "cooldown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un 429 del modelo activa el bloqueo global con su Retry-After", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "25" } })));
    const { writer } = chatWriters(enabled);
    await expect(writer.write(request(true))).rejects.toMatchObject({ kind: "http", status: 429 });
    expect(limiterState.blocked).toEqual([25_000]);
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
