import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "@/lib/engine/__tests__/helpers";
import type { GameState } from "@/lib/engine";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { MOVES_LLM } from "../config";
import { createMoveBreaker, createMoveSelector, MOVE_INVALID_REASONS, MoveLlmError, type MoveBreaker } from "../gateway";
import { logMoveError } from "../log";
import { buildMoveDecision } from "../options";
import { buildMovePrompt } from "../prompt";

vi.mock("server-only", () => ({}));

const KEY = "clave-secreta-de-prueba-123";
const config = { enabled: true as const, apiKey: KEY, model: MOVES_LLM.model, provider: null };
// Brava (pink) con un 3 y fichas en steps 20 y 30: opciones A (ficha 0) y B (ficha 1).
const state: GameState = { ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: CHARACTER_IDS[0], dice: 3 };
const decision = buildMoveDecision(state)!;

const completion = (content: unknown, finish = "stop", extra: Record<string, unknown> = {}) =>
  Response.json({ model: MOVES_LLM.model, choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], ...extra });

/** fetch falso que registra las peticiones y responde lo indicado (o se cuelga respetando la señal). */
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

function selectorWith(respond: Parameters<typeof fakeFetch>[0], extra: { breaker?: MoveBreaker; now?: () => number; timeoutMs?: number } = {}) {
  const f = fakeFetch(respond);
  const failures: MoveLlmError[] = [];
  const breaker = extra.breaker ?? createMoveBreaker();
  const selector = createMoveSelector({ config, fetch: f.fetch, breaker, now: extra.now, timeoutMs: extra.timeoutMs, onFailure: (e) => failures.push(e) });
  return { selector, calls: f.calls, failures, breaker };
}

afterEach(() => vi.restoreAllMocks());

describe("petición a AI Gateway", () => {
  it("POST al endpoint, clave solo en la cabecera, modelo exacto, prompt de F1 y sin reintentos", async () => {
    const t = selectorWith(() => completion('{"choice":"B"}'));
    expect(await t.selector.select(state, decision)).toEqual({ ok: true, id: "B", pieceIndex: 1 });
    expect(t.calls).toHaveLength(1);
    const { url, init, body } = t.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(body).toEqual({
      model: "nvidia/nemotron-3.5-lightning-free",
      messages: buildMovePrompt(state, decision),
      max_tokens: MOVES_LLM.maxTokens,
      temperature: MOVES_LLM.temperature,
      stream: false,
      reasoning_effort: "none",
    });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(body).not.toHaveProperty("models");
    expect(t.failures).toEqual([]);
  });

  it("con proveedor fijado: providerOptions.gateway.only", async () => {
    const f = fakeFetch(() => completion('{"choice":"A"}'));
    const selector = createMoveSelector({ config: { ...config, provider: "nvidia" }, fetch: f.fetch, breaker: createMoveBreaker() });
    expect(await selector.select(state, decision)).toEqual({ ok: true, id: "A", pieceIndex: 0 });
    expect(f.calls[0].body.providerOptions).toEqual({ gateway: { only: ["nvidia"] } });
  });
});

describe("respuestas del modelo", () => {
  it.each([
    ["JSON inválido", completion("{choice:B}"), "JSON inválido"],
    ["texto alrededor", completion('Elijo {"choice":"B"}'), "no es solo un objeto JSON"],
    ["Markdown", completion('```json\n{"choice":"B"}\n```'), "no es solo un objeto JSON"],
    ["identificador inexistente", completion('{"choice":"C"}'), "opción inexistente"],
    ["clave duplicada", completion('{"choice":"A","choice":"B"}'), "clave duplicada"],
    ["clave adicional", completion('{"choice":"B","reason":"capturo"}'), "formato no válido"],
    ["truncada (finish_reason length)", completion('{"choice":"B"}', "length"), "respuesta truncada"],
    ["sin texto", completion(null), "respuesta sin texto"],
    ["sin choices", Response.json({}), "respuesta sin texto"],
    ["cuerpo que no es JSON", new Response("<html>", { status: 200 }), "respuesta ilegible"],
  ])("%s → invalid_response con su motivo fijo, sin corte temporal y sin el texto del modelo", async (_, response, reason) => {
    const t = selectorWith(() => response);
    const result = await t.selector.select(state, decision);
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_response", message: reason } });
    expect(MOVE_INVALID_REASONS).toContain(reason);
    expect(t.failures).toHaveLength(1);
    expect(t.breaker.blockedUntil).toBe(0);
    expect(t.calls).toHaveLength(1);
    const detail = (result as { error: MoveLlmError }).error.detail ?? "";
    for (const secret of ["Elijo", "capturo", "html", KEY]) expect(detail).not.toContain(secret);
  });
});

describe("errores HTTP y corte temporal", () => {
  it.each([
    [401, MOVES_LLM.configErrorCooldownMs],
    [402, MOVES_LLM.configErrorCooldownMs],
    [403, MOVES_LLM.configErrorCooldownMs],
    [404, MOVES_LLM.configErrorCooldownMs],
    [500, MOVES_LLM.serverErrorCooldownMs],
    [503, MOVES_LLM.serverErrorCooldownMs],
  ])("%i → http con su código, corte temporal y sin llamar mientras dura", async (status, cooldown) => {
    let clock = 1_000_000;
    const t = selectorWith(() => Response.json({ error: { type: "x", message: `Invalid key ${KEY}` } }, { status }), { now: () => clock });
    const result = await t.selector.select(state, decision);
    expect(result).toMatchObject({ ok: false, error: { kind: "http", status } });
    expect((result as { error: MoveLlmError }).error.detail).not.toContain(KEY);
    expect(t.breaker.blockedUntil).toBe(1_000_000 + cooldown);
    // Durante el corte: falla al instante sin llamar.
    clock += cooldown - 1;
    expect(await t.selector.select(state, decision)).toMatchObject({ ok: false, error: { kind: "cooldown" } });
    expect(t.calls).toHaveLength(1);
    // Al terminar el corte, vuelve a llamar.
    clock += 1;
    await t.selector.select(state, decision);
    expect(t.calls).toHaveLength(2);
  });

  it("429: Retry-After válido (acotado a 1 h) o 60 s si falta o no es válido", async () => {
    for (const [retryAfter, expected] of [
      ["20", 20_000],
      ["999999", MOVES_LLM.maxRetryAfterMs],
      ["abc", MOVES_LLM.rateLimitCooldownMs],
      [null, MOVES_LLM.rateLimitCooldownMs],
    ] as const) {
      const t = selectorWith(() => new Response("{}", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} }), { now: () => 0 });
      expect(await t.selector.select(state, decision)).toMatchObject({ ok: false, error: { kind: "http", status: 429 } });
      expect(t.breaker.blockedUntil, String(retryAfter)).toBe(expected);
    }
  });

  it("400 y red caída: error sin corte temporal", async () => {
    const bad = selectorWith(() => new Response("{}", { status: 400 }));
    expect(await bad.selector.select(state, decision)).toMatchObject({ ok: false, error: { kind: "http", status: 400 } });
    expect(bad.breaker.blockedUntil).toBe(0);
    const down = selectorWith(() => "network");
    expect(await down.selector.select(state, decision)).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(down.breaker.blockedUntil).toBe(0);
  });

  it("isAvailable refleja el corte temporal (para no consumir cupo en una consulta que no se hará)", async () => {
    let clock = 0;
    const t = selectorWith(() => new Response("{}", { status: 503 }), { now: () => clock });
    expect(t.selector.isAvailable?.()).toBe(true);
    await t.selector.select(state, decision);
    expect(t.selector.isAvailable?.()).toBe(false);
    clock = MOVES_LLM.serverErrorCooldownMs;
    expect(t.selector.isAvailable?.()).toBe(true);
  });

  it("el corte temporal es propio: uno nuevo no hereda el de otro selector", async () => {
    const first = selectorWith(() => new Response("{}", { status: 503 }), { now: () => 0 });
    await first.selector.select(state, decision);
    expect(first.breaker.blockedUntil).toBeGreaterThan(0);
    const second = selectorWith(() => completion('{"choice":"A"}'), { now: () => 0 });
    expect(await second.selector.select(state, decision)).toEqual({ ok: true, id: "A", pieceIndex: 0 });
  });
});

describe("tiempo máximo y cancelación", () => {
  it("timeout: aborta la petición y devuelve timeout (sin corte temporal)", async () => {
    const t = selectorWith(() => "hang", { timeoutMs: 30 });
    const result = await t.selector.select(state, decision);
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(t.calls[0].init.signal!.aborted).toBe(true);
    expect(t.breaker.blockedUntil).toBe(0);
  });

  it("el tiempo máximo nunca supera 3 s, aunque se pida más", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await selectorWith(() => completion('{"choice":"A"}'), { timeoutMs: 60_000 }).selector.select(state, decision);
    await selectorWith(() => completion('{"choice":"A"}')).selector.select(state, decision);
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([3_000, 3_000]);
  });

  it("cancelación por quien llama: durante la petición, y si ya venía cancelada no se llama", async () => {
    const controller = new AbortController();
    const t = selectorWith(() => "hang", { timeoutMs: 3_000 });
    const pending = t.selector.select(state, decision, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(t.calls[0].init.signal!.aborted).toBe(true);
    const already = selectorWith(() => completion('{"choice":"A"}'));
    expect(await already.selector.select(state, decision, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(already.calls).toHaveLength(0);
  });

  it("una respuesta válida que llega cuando ya se ha cancelado no se usa", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"choice":"A"}' } }] }) } as unknown as Response;
    });
    const selector = createMoveSelector({ config, fetch: fetch as unknown as typeof globalThis.fetch, breaker: createMoveBreaker() });
    const pending = selector.select(state, decision, { signal: controller.signal });
    controller.abort();
    release();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });
});

describe("registro", () => {
  it("solo tipo, código y motivo fijo, con el resumen saneado; uno por minuto por motivo; nunca la clave", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logMoveError("selector", new MoveLlmError("http", "AI Gateway respondió 503", 503, "content-type=application/json"), 5_000_000);
    logMoveError("selector", new MoveLlmError("http", "AI Gateway respondió 503", 503, "otro"), 5_010_000);
    logMoveError("selector", new MoveLlmError("invalid_response", "opción inexistente"), 5_020_000);
    logMoveError("selector", new MoveLlmError("invalid_response", `texto del modelo ${KEY}`), 5_030_000);
    const lines = spy.mock.calls.map(([l]) => String(l));
    expect(lines).toEqual([
      "[move-llm] selector: LLM http (503) content-type=application/json",
      "[move-llm] selector: LLM invalid_response: opción inexistente",
      "[move-llm] selector: LLM invalid_response: motivo desconocido",
    ]);
    for (const line of lines) expect(line).not.toContain(KEY);
  });
});

describe("el selector nunca lanza", () => {
  it("con un fetch que lanza un error cualquiera devuelve network", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    const selector = createMoveSelector({ config, fetch: fetch as unknown as typeof globalThis.fetch, breaker: createMoveBreaker() });
    await expect(selector.select(state, decision)).resolves.toMatchObject({ ok: false, error: { kind: "network" } });
  });
});

describe("bloqueo global tras un 429 (limitador compartido con el chat)", () => {
  it("429: avisa con su Retry-After (o 60 s); 5xx, 400 y red no avisan; no reintenta", async () => {
    for (const [respond, expected] of [
      [() => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }), [30_000]],
      [() => new Response("{}", { status: 429 }), [MOVES_LLM.rateLimitCooldownMs]],
      [() => new Response("{}", { status: 503 }), []],
      [() => new Response("{}", { status: 400 }), []],
      [() => "network" as const, []],
    ] as const) {
      const onRateLimited = vi.fn(async (_ms: number) => {});
      const f = fakeFetch(respond as () => Response | "network");
      const selector = createMoveSelector({ config, fetch: f.fetch, breaker: createMoveBreaker(), onRateLimited });
      expect((await selector.select(state, decision)).ok).toBe(false);
      expect(onRateLimited.mock.calls.map(([ms]) => ms)).toEqual(expected);
      expect(f.calls).toHaveLength(1);
    }
  });
});

describe("registro de la estrategia local de movimientos (como lo escribe la ruta de avance)", () => {
  it("cada motivo se distingue en el registro, con su texto fijo", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reasons = ["límite global", "límite de movimientos", "bloqueo global", "cupo agotado", "limitador no disponible", "corte temporal local", "petición cancelada"];
    let t = 8_000_000;
    for (const reason of reasons) logMoveError("estrategia local", Object.assign(new Error(reason), { name: reason }), (t += 1));
    expect(spy.mock.calls.map(([line]) => String(line))).toEqual(reasons.map((r) => `[move-llm] estrategia local: ${r}`));
  });
});
