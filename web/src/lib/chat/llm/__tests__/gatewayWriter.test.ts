import { describe, expect, it, vi } from "vitest";
import { applyAction, createGame, type GameEvent } from "@/lib/engine";
import { createSeededRandom, decideAction } from "@/lib/game/ai";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { CHAT_LIMITS, CHAT_LLM } from "../../config";
import type { Utterance } from "../../director";
import { drainChat, type ChatDeps } from "../../service";
import { createLocalWriter, type ChatWriteRequest } from "../../writer";
import { createMemoryChatStore } from "../../__tests__/memoryChatStore";
import { ChatLlmError, cleanLlmText, createGatewayWriter, createImportantOnlyWriter, createLlmBreaker, type LlmBreaker } from "../gatewayWriter";

const KEY = "clave-secreta-de-prueba-123";
const MODEL = "nvidia/nemotron-3.5-lightning-free";
const config = { enabled: true as const, apiKey: KEY, model: MODEL, provider: null };
const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

const utterance = (extra: Partial<Utterance> = {}): Utterance => ({
  speaker: "ai-pink", kind: "capture_boast", rival: "ai-blue", trigger: "capture", replyTo: null, important: true, ...extra,
});
const request = (extra: Partial<ChatWriteRequest> = {}): ChatWriteRequest => ({ utterance: utterance(), recent: [], replyToText: null, ...extra });
const completion = (content: unknown, init: ResponseInit = {}) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] }, { status: 200, ...init });

/** fetch falso que registra las peticiones y responde con lo que se le indique (o se cuelga respetando la señal). */
function fakeFetch(respond: (call: number) => Response | "hang" | "network") {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init!, body: JSON.parse(String(init!.body)) });
    const r = respond(calls.length);
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }
    return r;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function writerWith(respond: Parameters<typeof fakeFetch>[0], extra: { breaker?: LlmBreaker; now?: () => number } = {}) {
  const f = fakeFetch(respond);
  const failures: ChatLlmError[] = [];
  const breaker = extra.breaker ?? createLlmBreaker();
  const writer = createGatewayWriter({ config, fetch: f.fetch, breaker, now: extra.now, onFailure: (e) => failures.push(e) });
  return { writer, calls: f.calls, failures, breaker };
}

describe("petición a AI Gateway", () => {
  it("POST al endpoint compatible con OpenAI, con la clave en Authorization y un cuerpo mínimo", async () => {
    const t = writerWith(() => completion("¡A casa, Chispa! Hoy no se me escapa nadie."));
    const result = await t.writer.write(request());
    expect(result).toEqual({ text: "¡A casa, Chispa! Hoy no se me escapa nadie.", source: "llm" });
    expect(t.calls).toHaveLength(1);
    const { url, init, body } = t.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(body).toMatchObject({ model: MODEL, max_tokens: CHAT_LLM.maxTokens, stream: false });
    expect(body).not.toHaveProperty("models"); // sin cambio automático de modelo
    expect(body).not.toHaveProperty("providerOptions");
    expect((body.messages as unknown[]).length).toBe(2);
    expect(JSON.stringify(body)).not.toContain(KEY); // la clave solo va en la cabecera
  });

  it("con proveedor fijado: providerOptions.gateway.only (sin cambio a otro proveedor)", async () => {
    const f = fakeFetch(() => completion("Una frase cualquiera de prueba."));
    const writer = createGatewayWriter({ config: { ...config, provider: "nvidia" }, fetch: f.fetch, breaker: createLlmBreaker() });
    await writer.write(request());
    expect(f.calls[0].body.providerOptions).toEqual({ gateway: { only: ["nvidia"] } });
  });

  it("una sola petición por intervención: ningún error provoca reintentos", async () => {
    for (const r of [new Response("x", { status: 500 }), new Response("x", { status: 429 }), "network" as const, completion("")]) {
      const t = writerWith(() => r);
      await expect(t.writer.write(request())).rejects.toBeInstanceOf(ChatLlmError);
      expect(t.calls).toHaveLength(1);
    }
  });
});

describe("cancelación y tiempo máximo", () => {
  it("pasa una señal al fetch y, si el servicio aborta, se cancela la petición y lanza `aborted`", async () => {
    const t = writerWith(() => "hang");
    const controller = new AbortController();
    const pending = t.writer.write(request({ signal: controller.signal, timeoutMs: 5_000 }));
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.calls[0].init.signal!.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(t.calls[0].init.signal!.aborted).toBe(true);
    expect(t.breaker.blockedUntil).toBe(0); // un aborto no abre el corte temporal
  });

  it("respeta su `timeoutMs` aunque nadie aborte (y nunca más de 8 s)", async () => {
    const t = writerWith(() => "hang");
    const started = Date.now();
    await expect(t.writer.write(request({ timeoutMs: 60 }))).rejects.toMatchObject({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("errores HTTP y corte temporal", () => {
  it.each([
    [401, CHAT_LLM.configErrorCooldownMs],
    [402, CHAT_LLM.configErrorCooldownMs],
    [403, CHAT_LLM.configErrorCooldownMs],
    [404, CHAT_LLM.configErrorCooldownMs],
    [500, CHAT_LLM.serverErrorCooldownMs],
  ])("%i → error `http` con su código y corte temporal; durante el corte no se llama", async (status, cooldown) => {
    let now = 1_000_000;
    const t = writerWith(() => Response.json({ error: { message: "x", type: "y" } }, { status }), { now: () => now });
    await expect(t.writer.write(request())).rejects.toMatchObject({ kind: "http", status });
    expect(t.breaker.blockedUntil).toBe(1_000_000 + cooldown);
    now += cooldown - 1;
    await expect(t.writer.write(request())).rejects.toMatchObject({ kind: "cooldown" });
    expect(t.calls).toHaveLength(1);
    now += 1;
    await expect(t.writer.write(request())).rejects.toMatchObject({ kind: "http" });
    expect(t.calls).toHaveLength(2);
  });

  it("429: respeta un Retry-After válido; si no lo es, espera el corte por defecto", async () => {
    const valid = writerWith(() => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }), { now: () => 0 });
    await expect(valid.writer.write(request())).rejects.toMatchObject({ kind: "http", status: 429 });
    expect(valid.breaker.blockedUntil).toBe(120_000);
    for (const header of ["", "abc", "0", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const t = writerWith(() => new Response("{}", { status: 429, headers: { "Retry-After": header } }), { now: () => 0 });
      await expect(t.writer.write(request())).rejects.toMatchObject({ status: 429 });
      expect(t.breaker.blockedUntil).toBe(CHAT_LLM.rateLimitCooldownMs);
    }
    const huge = writerWith(() => new Response("{}", { status: 429, headers: { "Retry-After": "999999" } }), { now: () => 0 });
    await expect(huge.writer.write(request())).rejects.toBeInstanceOf(ChatLlmError);
    expect(huge.breaker.blockedUntil).toBe(CHAT_LLM.maxRetryAfterMs);
  });

  it("400 y fallos de red: error, pero sin corte temporal", async () => {
    const bad = writerWith(() => new Response("{}", { status: 400 }));
    await expect(bad.writer.write(request())).rejects.toMatchObject({ kind: "http", status: 400 });
    expect(bad.breaker.blockedUntil).toBe(0);
    const offline = writerWith(() => "network");
    await expect(offline.writer.write(request())).rejects.toMatchObject({ kind: "network" });
    expect(offline.breaker.blockedUntil).toBe(0);
  });

  it("el aviso de fallo y el mensaje de error no contienen la clave ni el prompt", async () => {
    const t = writerWith(() => new Response("{}", { status: 401 }));
    await t.writer.write(request()).catch(() => {});
    expect(t.failures).toHaveLength(1);
    const text = JSON.stringify({ message: t.failures[0].message, kind: t.failures[0].kind, status: t.failures[0].status });
    expect(text).not.toContain(KEY);
    expect(text).not.toMatch(/Eres|Situación/);
  });
});

describe("respuestas del modelo", () => {
  it.each([
    ["JSON ilegible", () => new Response("<html>", { status: 200 })],
    ["sin choices", () => Response.json({}, { status: 200 })],
    ["contenido vacío", () => completion("   ")],
    ["contenido no texto", () => completion(null)],
  ])("%s → error (fallback local)", async (_, respond) => {
    const t = writerWith(respond as () => Response);
    await expect(t.writer.write(request())).rejects.toBeInstanceOf(ChatLlmError);
  });

  it("limpia comillas, el prefijo con su propio nombre y las líneas de más", () => {
    expect(cleanLlmText("«¡A casa, Chispa!»", request())).toBe("¡A casa, Chispa!");
    expect(cleanLlmText("Brava: ¡A casa, Chispa!", request())).toBe("¡A casa, Chispa!");
    expect(cleanLlmText("\n  ¡Fuera de mi tablero!\nSegunda línea que sobra", request())).toBe("¡Fuera de mi tablero!");
  });

  it("rechaza textos demasiado largos (no los corta), con formato o repetidos", () => {
    expect(() => cleanLlmText("a".repeat(CHAT_LLM.maxChars + 1), request())).toThrow(/largo/);
    expect(cleanLlmText("a".repeat(CHAT_LLM.maxChars), request())).toHaveLength(CHAT_LLM.maxChars);
    expect(() => cleanLlmText("Mira https://ejemplo.com", request())).toThrow(ChatLlmError);
    expect(() => cleanLlmText("**¡Toma!**", request())).toThrow(ChatLlmError);
    expect(() => cleanLlmText("¡A casa, Chispa!", request({ recent: [{ speaker: "ai-pink", text: "¡A casa, Chispa!" }] }))).toThrow(/repetido/);
  });

  it("rechaza hablar como otro personaje o nombrar a personajes ajenos a la intervención", () => {
    expect(() => cleanLlmText("Don Ernesto: Previsible.", request())).toThrow(/otro personaje/);
    expect(() => cleanLlmText("¡A casa, Chispa! Y tú, Abuela Pilar, la siguiente.", request())).toThrow(/ajeno/);
    // Quien habla y su rival sí se pueden nombrar.
    expect(cleanLlmText("Brava nunca falla, Chispa.", request())).toBe("Brava nunca falla, Chispa.");
  });
});

describe("solo las intervenciones importantes usan el LLM", () => {
  it("createImportantOnlyWriter: importantes → LLM; el resto → local, sin llamar al modelo", async () => {
    const llm = { write: vi.fn(async () => ({ text: "Del modelo, sin duda.", source: "llm" as const })) };
    const local = { write: vi.fn(async () => ({ text: "Frase local.", source: "local" as const })) };
    const writer = createImportantOnlyWriter(llm, local);
    expect(await writer.write(request({ utterance: utterance({ important: true }) }))).toMatchObject({ source: "llm" });
    expect(await writer.write(request({ utterance: utterance({ important: false, kind: "goal", trigger: "goal" }) }))).toMatchObject({ source: "local" });
    expect(llm.write).toHaveBeenCalledTimes(1);
    expect(local.write).toHaveBeenCalledTimes(1);
  });
});

describe("integración con drainChat", () => {
  const capture = (by: string, victim: string): GameEvent => ({ type: "piece_captured", playerId: by, victimId: victim, victimPieceIndex: 0, cell: 30 });
  const goal = (who: string): GameEvent => ({ type: "piece_reached_goal", playerId: who, pieceIndex: 0 });
  const TEXTS = ["¡Toma ya, esto es puro talento!", "No me lo puedo creer, qué mala suerte.", "Hoy el tablero es mío, que lo sepáis.", "Me las pagarás en la próxima ronda."];

  function setup(respond: Parameters<typeof fakeFetch>[0]) {
    const memory = createMemoryChatStore();
    const f = fakeFetch(respond);
    const local = createLocalWriter(createSeededRandom(1));
    const llm = createGatewayWriter({ config, fetch: f.fetch, breaker: createLlmBreaker() });
    let tokens = 0;
    const deps: ChatDeps = {
      store: memory.store,
      writer: createImportantOnlyWriter(llm, local),
      fallbackWriter: local,
      random: () => 0,
      newToken: () => `t${++tokens}`,
    };
    return { memory, deps, calls: f.calls };
  }

  it("captura (importante) con el LLM; meta (no importante) con el local; una llamada por intervención", async () => {
    let n = 0;
    const t = setup(() => completion(TEXTS[n++ % TEXTS.length]));
    t.memory.enqueue(GAME, 4, [capture("ai-pink", "ai-blue")], createGame([...CHARACTER_IDS]));
    t.memory.enqueue(GAME, 9, [goal("ai-green")], createGame([...CHARACTER_IDS]));
    expect(await drainChat(GAME, t.deps)).toMatchObject({ kind: "done", published: 3 });
    expect(t.memory.rows.map((r) => [r.version, r.trigger, r.source])).toEqual([[4, "capture", "llm"], [4, "capture", "llm"], [9, "goal", "local"]]);
    expect(t.calls).toHaveLength(2);
  });

  it("si el LLM falla (cuota, 500, red o respuesta inválida), se usa la frase local y la cola sigue intacta", async () => {
    for (const respond of [() => new Response("{}", { status: 402 }), () => new Response("{}", { status: 500 }), () => "network" as const, () => completion("Abuela Pilar: hola")]) {
      const t = setup(respond as () => Response);
      t.memory.enqueue(GAME, 4, [capture("ai-pink", "ai-blue")], createGame([...CHARACTER_IDS]));
      expect(await drainChat(GAME, t.deps)).toMatchObject({ kind: "done", published: 2 });
      expect(t.memory.rows.map((r) => r.source)).toEqual(["local", "local"]);
      expect(t.memory.queue).toEqual([]);
      expect(t.memory.chats.get(GAME)).toMatchObject({ lastVersion: 4, lockToken: null });
    }
  });

  it("si el LLM no responde, el tiempo máximo del servicio lo aborta y se usa el local, dentro de la reserva", async () => {
    const t = setup(() => "hang");
    t.deps.now = t.memory.clock;
    // El temporizador del servicio vence en una tarea posterior, "pasando" el plazo en el reloj de la BD.
    t.deps.setTimeout = (fn, ms) => setTimeout(() => (t.memory.advance(ms), fn()), 0);
    t.deps.clearTimeout = (h) => clearTimeout(h as ReturnType<typeof setTimeout>);
    t.memory.enqueue(GAME, 4, [capture("ai-pink", "ai-blue")], createGame([...CHARACTER_IDS]));
    expect(await drainChat(GAME, t.deps)).toMatchObject({ kind: "done", published: 2 });
    expect(t.memory.rows.map((r) => r.source)).toEqual(["local", "local"]);
    expect(t.calls.every((c) => c.init.signal!.aborted)).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.memory.clock()).toBeLessThanOrEqual(CHAT_LIMITS.leaseSeconds * 1000 - CHAT_LIMITS.commitMarginMs);
  });

  it("la victoria se publica aunque el LLM esté caído", async () => {
    const t = setup(() => new Response("{}", { status: 503 }));
    t.memory.enqueue(GAME, 7, [{ type: "player_finished", playerId: "ai-green", place: 1 }], createGame([...CHARACTER_IDS]));
    await drainChat(GAME, t.deps);
    expect(t.memory.rows[0]).toMatchObject({ version: 7, trigger: "victory", character_id: "ai-green", source: "local" });
  });

  it("partidas completas con un LLM inestable: victoria siempre, sin duplicados, cola vacía y LLM solo en lo importante", async () => {
    for (const seed of [21, 22, 23]) {
      // Respuestas que alternan éxitos y errores. El reloj del corte temporal avanza un día en cada
      // texto pedido, así que el corte nunca bloquea el siguiente: cada intervención importante llama.
      const statuses = [200, 200, 200, 500, 429, 200, 402, 200];
      let n = 0;
      let clock = 0;
      const unstable = vi.fn(async () => {
        const status = statuses[n++ % statuses.length];
        return status === 200 ? completion(`${TEXTS[n % TEXTS.length]} Va la número ${n}.`) : new Response("{}", { status });
      });
      const t = setup(() => completion("no se usa"));
      const llm = createGatewayWriter({ config, fetch: unstable as unknown as typeof fetch, breaker: createLlmBreaker(), now: () => clock });
      let writes = 0;
      t.deps.writer = createImportantOnlyWriter({ write: (r) => (writes++, (clock += 24 * 60 * 60_000), llm.write(r)) }, t.deps.fallbackWriter);

      const random = createSeededRandom(seed);
      let dieSeed = seed;
      const die = () => 1 + Math.floor((((dieSeed = (dieSeed * 16807) % 2147483647) - 1) / 2147483646) * 6);
      t.deps.random = random;
      let state = createGame([...CHARACTER_IDS]);
      let version = 1;
      while (state.status === "playing") {
        const result = applyAction(state, decideAction(state, die, random));
        if (!result.ok) throw new Error(result.error);
        state = result.state;
        t.memory.enqueue(GAME, ++version, result.events, state);
        await drainChat(GAME, t.deps);
      }

      const rows = t.memory.rows;
      expect(t.memory.queue).toEqual([]);
      expect(new Set(rows.map((r) => `${r.version}:${r.seq}`)).size).toBe(rows.length);
      expect(rows.filter((r) => r.trigger === "victory" && r.seq === 0)).toHaveLength(1);
      expect(rows.some((r) => r.source === "llm")).toBe(true);
      expect(rows.some((r) => r.source === "local")).toBe(true);
      // Solo victoria, capturas y rachas pueden venir del LLM; nunca más de una llamada por mensaje.
      for (const r of rows.filter((x) => x.source === "llm")) expect(["victory", "capture", "capture_streak", "bad_streak"]).toContain(r.trigger);
      expect(writes).toBeGreaterThan(0);
      expect(unstable.mock.calls.length).toBe(writes); // exactamente una petición HTTP por texto pedido, sin reintentos
      expect(rows.every((r) => r.text.length <= CHAT_LIMITS.maxTextLength)).toBe(true);
    }
  });
});
