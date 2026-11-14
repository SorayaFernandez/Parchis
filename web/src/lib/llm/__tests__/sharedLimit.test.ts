// El chat y el selector de movimientos comparten el MISMO limitador global: entre los dos, como mucho 4
// llamadas reales al modelo por ventana de 60 s (2 de cada uno), y un 429 de cualquiera bloquea a ambos.
// Clientes reales (escritor del chat y selector de F2) con fetch simulado; limitador real sobre el doble
// de Redis; reloj controlable. Sin llamar a AI Gateway ni a Upstash.
import { describe, expect, it, vi } from "vitest";
import type { GameState } from "@/lib/engine";
import { setup } from "@/lib/engine/__tests__/helpers";
import { createGatewayWriter, createLlmBreaker } from "@/lib/chat/llm/gatewayWriter";
import type { ChatWriteRequest } from "@/lib/chat/writer";
import type { Utterance } from "@/lib/chat/director";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { MOVES_LLM } from "@/lib/game/moveSelector/config";
import { decideActionWithSelector } from "@/lib/game/moveSelector/decide";
import { createMoveBreaker, createMoveSelector } from "@/lib/game/moveSelector/gateway";
import { createLimitedMoveQuota } from "@/lib/game/moveSelector/quota";
import { createGatewayLimiter } from "../gatewayLimiter";
import { memoryLimiterRedis } from "./memoryLimiterRedis";

vi.mock("server-only", () => ({}));

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const KEY = "clave-de-prueba";
const state: GameState = { ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: CHARACTER_IDS[0], dice: 3 };
const chatRequest = (): ChatWriteRequest => ({
  utterance: { speaker: "ai-pink", kind: "capture_boast", rival: "ai-blue", trigger: "capture", replyTo: null, important: true } as Utterance,
  recent: [],
  replyToText: null,
});

function world(respondChat: () => Response = () => Response.json({ choices: [{ message: { content: "¡A casa, Chispa! Hoy no se me escapa nadie." } }] }),
  respondMoves: () => Response = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"choice":"B"}' } }] })) {
  const m = memoryLimiterRedis(undefined, { latency: false });
  const limiter = createGatewayLimiter(m.redis, { now: () => m.clock.now });
  const chatFetch = vi.fn(async () => respondChat());
  const movesFetch = vi.fn(async () => respondMoves());
  const writer = createGatewayWriter({
    config: { enabled: true, apiKey: KEY, model: MOVES_LLM.model, provider: null },
    fetch: chatFetch as unknown as typeof fetch,
    breaker: createLlmBreaker(),
    acquire: async () => (await limiter.acquire({ consumer: "chat" })).kind === "allowed",
    onRateLimited: (ms) => limiter.reportRateLimited(ms),
  });
  const selector = createMoveSelector({
    config: { enabled: true, apiKey: KEY, model: MOVES_LLM.model, provider: null },
    fetch: movesFetch as unknown as typeof fetch,
    breaker: createMoveBreaker(),
    onRateLimited: (ms) => limiter.reportRateLimited(ms),
  });
  const quota = createLimitedMoveQuota(limiter);
  const chat = () => writer.write(chatRequest()).then((r) => r?.source ?? null, () => "local");
  const move = () => decideActionWithSelector(state, { rollDie: () => 1, selector, consumeQuota: () => quota.tryConsume(GAME) }).then((d) => d.source);
  return { m, limiter, chatFetch, movesFetch, chat, move };
}

describe("límite compartido entre el chat y los movimientos", () => {
  it("en una misma ventana: 2 llamadas reales del chat y 2 de movimientos; el resto, respuesta local sin llamar", async () => {
    const w = world();
    const sources = [];
    for (let i = 0; i < 3; i++) sources.push(await w.chat(), await w.move());
    expect(w.chatFetch).toHaveBeenCalledTimes(2);
    expect(w.movesFetch).toHaveBeenCalledTimes(2);
    expect(sources).toEqual(["llm", "llm", "llm", "llm", "local", "local"]);
  });

  it("10 minutos de demanda alta de los dos: en ningún intervalo de 60 s hay más de 4 llamadas reales al modelo", async () => {
    const w = world();
    const calls: number[] = [];
    w.chatFetch.mockImplementation(async () => {
      calls.push(w.m.clock.now);
      return Response.json({ choices: [{ message: { content: `¡A casa, Chispa! Van ${calls.length} hoy.` } }] });
    });
    w.movesFetch.mockImplementation(async () => {
      calls.push(w.m.clock.now);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"choice":"A"}' } }] });
    });
    for (let t = 0; t < 600; t += 2) {
      await Promise.all([w.chat(), w.move(), w.chat(), w.move()]);
      w.m.clock.now += 2_000;
    }
    for (const start of calls) expect(calls.filter((c) => c >= start && c < start + 60_000).length).toBeLessThanOrEqual(4);
    // Y el cupo de la partida nunca pasa de 20.
    expect(w.movesFetch.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("un 429 del chat bloquea también los movimientos (y al revés), sin reintentos", async () => {
    const fromChat = world(() => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    expect(await fromChat.chat()).toBe("local");
    expect(await fromChat.move()).toBe("local");
    expect(fromChat.movesFetch).not.toHaveBeenCalled();
    expect(fromChat.chatFetch).toHaveBeenCalledTimes(1);

    const fromMoves = world(undefined, () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    expect(await fromMoves.move()).toBe("local");
    expect(await fromMoves.chat()).toBe("local");
    expect(fromMoves.chatFetch).not.toHaveBeenCalled();
    expect(fromMoves.movesFetch).toHaveBeenCalledTimes(1);
    fromMoves.m.clock.now += 30_000;
    expect(await fromMoves.chat()).toBe("llm");
  });
});
