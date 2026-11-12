import { describe, expect, it, vi } from "vitest";
import { applyAction, createGame, type GameEvent } from "@/lib/engine";
import { createSeededRandom, decideAction } from "@/lib/game/ai";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { CHAT_LIMITS, CHAT_LLM } from "../../config";
import type { Utterance } from "../../director";
import { drainChat, type ChatDeps } from "../../service";
import { createLocalWriter, type ChatWriteRequest } from "../../writer";
import { createMemoryChatStore } from "../../__tests__/memoryChatStore";
import { detectCatchphrases } from "../../catchphrases";
import { logChatError } from "../../log";
import { buildChatPrompt } from "../prompt";
import {
  ChatLlmError,
  cleanLlmText,
  createGatewayWriter,
  createImportantOnlyWriter,
  createLlmBreaker,
  describeCompletion,
  describeHttpError,
  INVALID_RESPONSE_REASONS,
  redactSecrets,
  type LlmBreaker,
} from "../gatewayWriter";

// `log.ts` importa el almacén del chat (solo servidor).
vi.mock("server-only", () => ({}));

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

  it("desactiva el razonamiento con reasoning_effort = none en la raíz del JSON enviado, sin chat_template_kwargs; el resto no cambia", async () => {
    for (const provider of [null, "nvidia"]) {
      const f = fakeFetch(() => completion("Una frase cualquiera de prueba."));
      const writer = createGatewayWriter({ config: { ...config, provider }, fetch: f.fetch, breaker: createLlmBreaker() });
      await writer.write(request());
      expect(f.calls).toHaveLength(1);
      // Lo que se comprueba es el JSON tal y como se pasa a fetch (init.body).
      const sent = JSON.parse(String(f.calls[0].init.body)) as Record<string, unknown>;
      expect(sent.reasoning_effort).toBe("none");
      expect(sent).not.toHaveProperty("chat_template_kwargs");
      expect(Object.keys(sent).sort()).toEqual(
        ["max_tokens", "messages", "model", "reasoning_effort", "stream", "temperature", ...(provider ? ["providerOptions"] : [])].sort(),
      );
      expect(sent).toMatchObject({ model: MODEL, max_tokens: 60, temperature: CHAT_LLM.temperature, stream: false });
      expect(CHAT_LLM.maxTokens).toBe(60);
      expect(sent.messages).toEqual(buildChatPrompt(request()));
      // No queda anidado en otro objeto (ni en providerOptions ni en los mensajes).
      expect(provider ? sent.providerOptions : undefined).toEqual(provider ? { gateway: { only: ["nvidia"] } } : undefined);
      expect(JSON.stringify(sent.providerOptions ?? {})).not.toContain("reasoning_effort");
      expect(JSON.stringify(sent.messages)).not.toContain("reasoning_effort");
      expect(String(f.calls[0].init.body).match(/reasoning_effort/g)).toHaveLength(1);
      expect(String(f.calls[0].init.body)).not.toMatch(/chat_template_kwargs|enable_thinking/);
    }
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

describe("diagnóstico de errores HTTP (resumen saneado)", () => {
  const VERCEL_ID = "cdg1::iad1::abcde-1731400000000-0123456789ab";
  const TOKEN = "vck_1A2b3C4d5E6f7G8h9I0jKlMnOp";
  const jsonError = (status: number, error: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8", "x-vercel-id": VERCEL_ID, ...headers } });
  const failWith = async (response: Response) => {
    const t = writerWith(() => response);
    const error = await t.writer.write(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatLlmError);
    return { error: error as ChatLlmError, t };
  };

  it("JSON con `error`: content-type, x-vercel-id, type, code y message", async () => {
    const { error, t } = await failWith(jsonError(403, { type: "forbidden", code: "customer_verification_required", message: "Access denied for this team." }));
    expect(error).toMatchObject({ kind: "http", status: 403, message: "AI Gateway respondió 403" }); // el mensaje no cambia
    expect(error.detail).toBe(
      `content-type=application/json x-vercel-id=${VERCEL_ID} error.type=forbidden error.code=customer_verification_required error.message=Access denied for this team.`,
    );
    expect(t.failures[0].detail).toBe(error.detail);
  });

  it("JSON con `error` de texto, sin `error` o con campos que no son texto", async () => {
    expect((await failWith(jsonError(403, "No autorizado"))).error.detail).toContain("error.message=No autorizado");
    expect((await failWith(new Response('{"ok":false}', { status: 403, headers: { "content-type": "application/json" } }))).error.detail).toBe(
      "content-type=application/json cuerpo=json-sin-error",
    );
    const odd = (await failWith(jsonError(403, { type: { a: 1 }, code: 42, message: ["x"] }))).error.detail;
    expect(odd).toBe(`content-type=application/json x-vercel-id=${VERCEL_ID} error.code=42`);
  });

  it("HTML u otro texto: solo el tipo de contenido, nunca el cuerpo", async () => {
    const html = `<html><body>Forbidden. Bearer ${KEY} ${TOKEN}</body></html>`;
    const { error } = await failWith(new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(error.detail).toBe("content-type=text/html cuerpo=no-json");
    const plain = await failWith(new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    expect(plain.error.detail).toBe("content-type=text/plain cuerpo=no-json");
  });

  it("cuerpo vacío, ilegible o enorme (lee como mucho 2 KB) y cabeceras con formato no válido", async () => {
    expect((await failWith(new Response(null, { status: 403 }))).error.detail).toBe("content-type=? cuerpo=vacío");
    const broken = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("roto")) });
    expect((await failWith(new Response(broken, { status: 403 }))).error.detail).toBe("content-type=? cuerpo=ilegible");
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => { pulls++; c.enqueue(new TextEncoder().encode(`{"error":"${"x".repeat(1000)}`)); } });
    expect((await failWith(new Response(endless, { status: 403 }))).error.detail).toBe("content-type=? cuerpo=no-json");
    expect(pulls).toBeLessThanOrEqual(4);
    const weird = await failWith(jsonError(403, { type: "x" }, { "content-type": "<script>", "x-vercel-id": `Bearer ${KEY}` }));
    expect(weird.error.detail).toBe("content-type=? x-vercel-id=[no válido] error.type=x");
  });

  it("enmascara Bearer, la clave y cadenas con aspecto de token; recorta y deja una línea", async () => {
    const message = `Invalid key ${KEY}. Header: Bearer abc.def-ghi\nToken ${TOKEN} code customer_verification_required`;
    const { error } = await failWith(jsonError(401, { type: "authentication_error", message }));
    expect(error.detail).toContain("error.message=Invalid key [oculto]. Header: Bearer [oculto] Token [oculto] code customer_verification_required");
    expect(error.detail).not.toContain(KEY);
    expect(error.detail).not.toContain(TOKEN);
    expect(error.detail).not.toContain("abc.def");
    expect(redactSecrets("ABCDEFGHIJKLMNOPQRSTUVWXyz", 100)).toBe("[oculto]"); // mayúsculas y minúsculas
    expect(redactSecrets("model_not_found_for_this_team", 100)).toBe("model_not_found_for_this_team");
    expect(redactSecrets("a".repeat(300), 200)).toBe(`${"a".repeat(200)}…`);
    expect(redactSecrets("short-secret-1", 100, "short-secret-1")).toBe("[oculto]");
    expect(await describeHttpError(jsonError(403, { message: `x ${TOKEN}` }))).not.toContain(TOKEN);
  });

  it("el registro incluye el resumen sin secretos ni prompt, y sigue limitado a uno por minuto por tipo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stage = "escritor LLM (prueba de diagnóstico)";
      const first = (await failWith(jsonError(403, { type: "forbidden", message: `Bearer ${KEY} ${TOKEN}` }))).error;
      logChatError(stage, first, 5_000_000);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toBe(`[chat] ${stage}: LLM http (403) content-type=application/json x-vercel-id=${VERCEL_ID} error.type=forbidden error.message=Bearer [oculto] [oculto]`);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toMatch(/Eres|Situación|Authorization/);
      // Otro identificador de petición dentro del mismo minuto: no se registra otra vez.
      const second = (await failWith(jsonError(403, { type: "forbidden" }, { "x-vercel-id": "cdg1::iad1::otro-1731400000001-ffff" }))).error;
      logChatError(stage, second, 5_030_000);
      expect(spy).toHaveBeenCalledTimes(1);
      logChatError(stage, second, 5_061_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("se mantiene el corte temporal y la reserva local aunque el cuerpo no se pueda leer", async () => {
    let now = 1_000_000;
    const broken = () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("roto")) }), { status: 403 });
    const t = writerWith(broken, { now: () => now });
    await expect(t.writer.write(request())).rejects.toMatchObject({ kind: "http", status: 403, detail: "content-type=? cuerpo=ilegible" });
    expect(t.breaker.blockedUntil).toBe(1_000_000 + CHAT_LLM.configErrorCooldownMs);
    now += 1;
    await expect(t.writer.write(request())).rejects.toMatchObject({ kind: "cooldown" });
    expect(t.calls).toHaveLength(1);
    const html = writerWith(() => new Response("<html>x</html>", { status: 500, headers: { "content-type": "text/html" } }), { now: () => 0 });
    await expect(html.writer.write(request())).rejects.toMatchObject({ kind: "http", status: 500 });
    expect(html.breaker.blockedUntil).toBe(CHAT_LLM.serverErrorCooldownMs);
  });
});

describe("diagnóstico de respuestas rechazadas (invalid_response)", () => {
  const SECRET_TEXT = "Texto secreto generado por el modelo que nunca debe aparecer";
  const REASONING = "Razonamiento interno del modelo que tampoco debe aparecer en el registro";
  const body = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    Response.json({ id: "x", model: MODEL, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", ...message } }], ...extra });
  const rejectWith = async (response: Response) => {
    const t = writerWith(() => response);
    const error = await t.writer.write(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatLlmError);
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(t.breaker.blockedUntil).toBe(0); // sin corte temporal, como antes
    expect(t.calls).toHaveLength(1);
    return error as ChatLlmError;
  };
  const noLeaks = (text: string | undefined) => {
    expect(text).toBeDefined();
    for (const secret of [SECRET_TEXT, REASONING, "Secreto", "Razonamiento", KEY, "Eres", "Situación"]) expect(text).not.toContain(secret);
  };

  it("content null por agotar max_tokens razonando: finish_reason, razonamiento y usage, sin su texto", async () => {
    const response = Response.json({
      model: MODEL,
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: null, reasoning: REASONING, reasoning_content: REASONING } }],
      usage: { prompt_tokens: 300, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 60 } },
    });
    const error = await rejectWith(response);
    expect(error.message).toBe("respuesta sin texto");
    expect(error.detail).toBe(
      `choices=1 finish_reason=length content=null razonamiento=reasoning:string(${REASONING.length}),reasoning_content:string(${REASONING.length}) usage=completion_tokens=60 reasoning_tokens=60 model=${MODEL}`,
    );
    noLeaks(error.detail);
  });

  it("content en array de partes: se sigue rechazando (respuesta sin texto) y se anotan los tipos", async () => {
    const error = await rejectWith(body({ content: [{ type: "text", text: SECRET_TEXT }, { type: "reasoning", text: REASONING }, { type: "Raro tipo" }] }));
    expect(error.message).toBe("respuesta sin texto");
    expect(error.detail).toContain("content=array(3:text,reasoning,?)");
    noLeaks(error.detail);
  });

  it("textos rechazados: motivo correcto y solo longitud, líneas y <think>", async () => {
    const long = await rejectWith(body({ content: `${SECRET_TEXT} ${"y".repeat(140)}` }));
    expect(long.message).toBe("texto demasiado largo");
    expect(long.detail).toContain(`content=string(${SECRET_TEXT.length + 141}) lineas=1 think=no`);
    noLeaks(long.detail);
    const think = await rejectWith(body({ content: `<think>\n${REASONING}\n</think>\n${SECRET_TEXT}` }));
    expect(think.message).toBe("texto repetido o no válido");
    expect(think.detail).toContain("lineas=4 think=sí");
    noLeaks(think.detail);
    const markdown = await rejectWith(body({ content: `**${SECRET_TEXT}**` }));
    expect(markdown.message).toBe("formato no permitido");
    noLeaks(markdown.detail);
  });

  it("valores no válidos de finish_reason, model, usage o tipos de parte → ? (nunca su contenido)", async () => {
    const error = await rejectWith(
      Response.json({
        model: `Bearer ${KEY}`,
        choices: [{ finish_reason: `stop ${SECRET_TEXT}`, message: { content: "" } }],
        usage: { completion_tokens: "60 tokens", completion_tokens_details: { reasoning_tokens: -1 } },
      }),
    );
    expect(error.message).toBe("texto vacío");
    expect(error.detail).toBe("choices=1 finish_reason=? content=string(0) lineas=1 think=no razonamiento=ausente usage=completion_tokens=? reasoning_tokens=? model=?");
    noLeaks(error.detail);
    expect(describeCompletion(null)).toBe("choices=ausente finish_reason=ausente content=ausente razonamiento=ausente usage=ausente model=ausente");
    expect(describeCompletion({ choices: "x" })).toContain("choices=string(1)");
    expect(describeCompletion({ choices: [] })).toContain("choices=0 finish_reason=ausente content=ausente");
  });

  it("cada motivo de cleanLlmText es uno de los textos fijos que se registran", () => {
    const reasons = new Set<string>();
    for (const raw of [null, "Don Ernesto: hola", '""', "a".repeat(141), "**hola**", "Saluda a Abuela Pilar", "hola {rival}"]) {
      try {
        cleanLlmText(raw, request());
      } catch (error) {
        reasons.add((error as ChatLlmError).message);
      }
    }
    expect(reasons.size).toBe(7);
    for (const reason of reasons) expect(INVALID_RESPONSE_REASONS).toContain(reason);
  });

  it("el registro incluye el motivo y el resumen, sin texto del modelo, prompt ni clave; uno por minuto por motivo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stage = "escritor LLM (prueba de invalid_response)";
      const first = await rejectWith(body({ content: null, reasoning: REASONING }, { usage: { completion_tokens: 60 } }));
      logChatError(stage, first, 7_000_000);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toBe(
        `[chat] ${stage}: LLM invalid_response: respuesta sin texto choices=1 finish_reason=stop content=null razonamiento=reasoning:string(${REASONING.length}) usage=completion_tokens=60 model=${MODEL}`,
      );
      noLeaks(line);
      // Mismo motivo con otro resumen dentro del minuto: no se repite.
      logChatError(stage, await rejectWith(body({ content: [] })), 7_010_000);
      expect(spy).toHaveBeenCalledTimes(1);
      // Otro motivo: sí se registra (conjunto cerrado de motivos).
      const long = await rejectWith(body({ content: `${SECRET_TEXT} ${"y".repeat(140)}` }));
      logChatError(stage, long, 7_020_000);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[1][0])).toContain("LLM invalid_response: texto demasiado largo");
      noLeaks(String(spy.mock.calls[1][0]));
      // Un mensaje que no es un motivo conocido nunca se registra tal cual.
      logChatError(stage, new ChatLlmError("invalid_response", SECRET_TEXT), 7_030_000);
      expect(String(spy.mock.calls[2][0])).toBe(`[chat] ${stage}: LLM invalid_response: motivo desconocido`);
    } finally {
      spy.mockRestore();
    }
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
    // (Sin hablar de sí misma en tercera persona: ver quality.ts.)
    expect(cleanLlmText("Soy Brava y nunca fallo, Chispa.", request())).toBe("Soy Brava y nunca fallo, Chispa.");
  });

  // Habla Don Ernesto y su rival es Abuela Pilar: Brava y Chispa son ajenas a la intervención.
  const ernesto = () => request({ utterance: utterance({ speaker: "ai-purple", rival: "ai-green" }) });
  const rejection = (text: string, req = ernesto()) => {
    try {
      cleanLlmText(text, req);
    } catch (error) {
      return error as ChatLlmError;
    }
    return null;
  };

  it("palabras comunes que contienen un nombre (bravata, chispazo, bravas) no son menciones", () => {
    for (const text of ["Menuda bravata la tuya, Pilar.", "¡Vaya chispazo de suerte!", "Esto pide unas bravas y un buen café.", "Chispeante jugada, lo admito.", "Bravamente defendido, no lo niego."]) {
      expect(cleanLlmText(text, ernesto())).toBe(text);
    }
  });

  it("menciones reales a personajes ajenos: palabra completa, sin distinguir mayúsculas, con signos o espacios", () => {
    for (const [text, name, form] of [
      ["¡Chispa, prepárate!", "Chispa", "capitalizada"],
      ["Hoy la chispa me acompaña.", "Chispa", "minúsculas"],
      ["Ni BRAVA podría con esto.", "Brava", "mayúsculas"],
      ["«Brava» se va a enterar.", "Brava", "capitalizada"],
      ["Brava2 no, Brava sí.", "Brava", "capitalizada"],
    ] as const) {
      const error = rejection(text);
      expect(error, text).toMatchObject({ kind: "invalid_response", message: "nombra a un personaje ajeno a la intervención" });
      expect(error!.detail).toBe(`nombre=${name} coincidencia=palabra forma=${form}`);
    }
    // Nombres compuestos, también en minúsculas o con varios espacios (habla Brava contra Chispa).
    expect(rejection("Ojo, don ernesto acecha.", request())!.detail).toBe("nombre=Don Ernesto coincidencia=palabra forma=minúsculas");
    expect(rejection("Ojo, Don  Ernesto acecha.", request())!.detail).toBe("nombre=Don Ernesto coincidencia=palabra forma=capitalizada");
    expect(rejection("Ya verás, (Abuela Pilar).", request())!.detail).toBe("nombre=Abuela Pilar coincidencia=palabra forma=capitalizada");
    expect(rejection("Ya verás, ABUELA pilar.", request())!.detail).toBe("nombre=Abuela Pilar coincidencia=palabra forma=mixta");
  });

  it("quien habla y su rival se pueden nombrar; en la victoria (sin rival) solo el propio nombre", () => {
    expect(cleanLlmText("Le habla Don Ernesto, Abuela Pilar: era previsible.", ernesto())).toBe("Le habla Don Ernesto, Abuela Pilar: era previsible.");
    const win = request({ utterance: utterance({ speaker: "ai-blue", kind: "victory_win", trigger: "victory", rival: null }) });
    expect(cleanLlmText("¡Victoria para Chispa, a toda velocidad!", win)).toBe("¡Victoria para Chispa, a toda velocidad!");
    expect(rejection("¡Gané! Brava, toma nota.", win)!.detail).toBe("nombre=Brava coincidencia=palabra forma=capitalizada");
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

  it("nombre ajeno: el diagnóstico lleva el nombre y la forma (sin el texto) y se usa la frase local una sola vez por intervención", async () => {
    const memory = createMemoryChatStore();
    const MODEL_TEXT = "Hoy la chispa me acompaña, secreto";
    const f = fakeFetch(() => completion(MODEL_TEXT));
    const failures: ChatLlmError[] = [];
    const llm = createGatewayWriter({ config, fetch: f.fetch, breaker: createLlmBreaker(), onFailure: (e) => failures.push(e) });
    const baseLocal = createLocalWriter(createSeededRandom(1));
    const localWrite = vi.fn(baseLocal.write);
    const local = { write: localWrite };
    let tokens = 0;
    const deps: ChatDeps = { store: memory.store, writer: createImportantOnlyWriter(llm, local), fallbackWriter: local, random: () => 0, newToken: () => `t${++tokens}` };
    memory.enqueue(GAME, 4, [capture("ai-purple", "ai-green")], createGame([...CHARACTER_IDS]));
    const result = await drainChat(GAME, deps);
    expect(result).toMatchObject({ kind: "done" });
    const published = memory.rows.length;
    expect(published).toBeGreaterThanOrEqual(1);
    expect(memory.rows.every((r) => r.source === "local")).toBe(true);
    // Una llamada al LLM y un uso del local por cada intervención; sin corte temporal.
    expect(f.calls).toHaveLength(published);
    expect(localWrite).toHaveBeenCalledTimes(published);
    expect(failures).toHaveLength(published);
    for (const failure of failures) {
      expect(failure).toMatchObject({ kind: "invalid_response", message: "nombra a un personaje ajeno a la intervención" });
      expect(failure.detail).toMatch(/^nombre=Chispa coincidencia=palabra forma=minúsculas choices=1 /);
      expect(failure.detail).not.toContain("acompaña");
      expect(failure.detail).not.toContain("secreto");
    }
    expect(memory.queue).toEqual([]);
  });

  it("regla de calidad (inglés): el diagnóstico lleva el término del catálogo y se usa la frase local una sola vez", async () => {
    const memory = createMemoryChatStore();
    const MODEL_TEXT = "Despacito y buena letra. Who laughs last laughs best, secreto";
    const f = fakeFetch(() => completion(MODEL_TEXT));
    const failures: ChatLlmError[] = [];
    const llm = createGatewayWriter({ config, fetch: f.fetch, breaker: createLlmBreaker(), onFailure: (e) => failures.push(e) });
    const baseLocal = createLocalWriter(createSeededRandom(1));
    const localWrite = vi.fn(baseLocal.write);
    const local = { write: localWrite };
    let tokens = 0;
    const deps: ChatDeps = { store: memory.store, writer: createImportantOnlyWriter(llm, local), fallbackWriter: local, random: () => 0, newToken: () => `t${++tokens}` };
    memory.enqueue(GAME, 4, [capture("ai-purple", "ai-green")], createGame([...CHARACTER_IDS]));
    expect(await drainChat(GAME, deps)).toMatchObject({ kind: "done" });
    const published = memory.rows.length;
    expect(published).toBeGreaterThanOrEqual(1);
    expect(memory.rows.every((r) => r.source === "local")).toBe(true);
    expect(f.calls).toHaveLength(published);
    expect(localWrite).toHaveBeenCalledTimes(published);
    for (const failure of failures) {
      expect(failure).toMatchObject({ kind: "invalid_response", message: "idioma no permitido" });
      expect(failure.detail).toMatch(/^termino=who laughs last choices=1 /);
      expect(failure.detail).not.toContain("laughs best");
      expect(failure.detail).not.toContain("secreto");
      expect(failure.detail).not.toContain("Despacito");
    }
    expect(memory.queue).toEqual([]);
  });

  it("registro de coletillas: cientos de versiones después, la coletilla de Pilar se rechaza y el rechazo no entra en el registro", async () => {
    const memory = createMemoryChatStore();
    const replies = [
      "Despacito y buena letra, cariño: esa ficha, a su casita.", // v10, Pilar (LLM, aceptada)
      "¡Vaya, qué mala pata la mía!", // v10, réplica de Chispa
      "Despacito y buena letra, hijo. Quien ríe el último…", // v600, Pilar (repite la coletilla 0)
      "Era cuestión de tiempo, señora.", // v600, réplica de Ernesto
    ];
    let call = 0;
    const f = fakeFetch(() => completion(replies[call++] ?? "Sin más."));
    const failures: ChatLlmError[] = [];
    const llm = createGatewayWriter({ config, fetch: f.fetch, breaker: createLlmBreaker(), onFailure: (e) => failures.push(e) });
    const local = createLocalWriter(createSeededRandom(1));
    let tokens = 0;
    const deps: ChatDeps = { store: memory.store, writer: createImportantOnlyWriter(llm, local), fallbackWriter: local, random: () => 0, newToken: () => `t${++tokens}` };
    const state = () => memory.chats.get(GAME)!.directorState as { recent: { speaker: string; text: string }[]; usedCatchphrases: Record<string, number[]> };

    memory.enqueue(GAME, 10, [capture("ai-green", "ai-blue")], createGame([...CHARACTER_IDS]));
    await drainChat(GAME, deps);
    expect(memory.rows[0]).toMatchObject({ character_id: "ai-green", source: "llm" });
    expect(state().usedCatchphrases["ai-green"]).toEqual([0]);
    // Más de 12 mensajes locales (metas) entre medias: el texto de Pilar sale de la ventana de recientes.
    // (Se procesan una a una: encoladas de golpe, las antiguas quedarían desfasadas y no hablarían.)
    for (let i = 0; i < 14; i++) {
      memory.enqueue(GAME, 20 + i * 4, [goal(CHARACTER_IDS[i % 4])], createGame([...CHARACTER_IDS]));
      await drainChat(GAME, deps);
    }
    expect(memory.rows.filter((r) => r.trigger === "goal").length).toBeGreaterThan(12);
    expect(state().recent.some((r) => r.text.startsWith("Despacito y buena letra, cariño"))).toBe(false);

    memory.enqueue(GAME, 600, [capture("ai-green", "ai-purple")], createGame([...CHARACTER_IDS]));
    await drainChat(GAME, deps);
    const pilar600 = memory.rows.find((r) => r.version === 600 && r.character_id === "ai-green")!;
    expect(pilar600.source).toBe("local"); // rechazada por el registro → frase local
    expect(failures.some((e) => e.message === "expresión característica repetida" && e.detail?.startsWith("termino=Despacito y buena letra"))).toBe(true);
    // El registro de Pilar solo refleja lo publicado: el texto rechazado (que también traía la coletilla 2) no cuenta.
    const published = memory.rows.filter((r) => r.character_id === "ai-green").flatMap((r) => detectCatchphrases("ai-green", r.text));
    expect(state().usedCatchphrases["ai-green"]).toEqual([...new Set(published)]);
    expect(published.includes(2)).toBe(false);
    expect(state().usedCatchphrases["ai-green"]).not.toContain(2);
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
