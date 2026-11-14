// Fase 8.3, F3: el selector estratégico con LLM dentro de `advanceGame`, con el repositorio en memoria
// (reserva, versión y reloj) y sin llamar a AI Gateway (fetch simulado o selectores inyectados).
import { describe, expect, it, vi } from "vitest";
import { applyAction, createGame, getAvailableMoves, type GameState } from "@/lib/engine";
import { setup } from "@/lib/engine/__tests__/helpers";
import { advanceGame, type AdvanceDeps } from "../advance";
import { CHARACTER_IDS } from "../characters";
import { MOVES_LLM } from "../moveSelector/config";
import type { MoveFallbackReason } from "../moveSelector/decide";
import { createMoveBreaker, createMoveSelector, MoveLlmError, type MoveBreaker, type MoveSelector } from "../moveSelector/gateway";
import type { MoveQuota } from "../moveSelector/quota";
import { LEASE_MS, createMemoryRepository } from "./memoryRepository";

vi.mock("server-only", () => ({}));

// Se cuenta cuántas veces se usa la estrategia local (`decideAction`, que llama a `chooseMove`).
const localCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ai")>();
  return {
    ...original,
    decideAction: (...args: Parameters<typeof original.decideAction>) => {
      localCalls.count++;
      return original.decideAction(...args);
    },
  };
});
const { chooseMove, createSeededRandom } = await import("../ai");

const [BRAVA] = CHARACTER_IDS;
const config = { enabled: true as const, apiKey: "clave-de-prueba", model: MOVES_LLM.model, provider: null };

/** Turno de Brava con un 3 y fichas en steps 20 y 30: dos opciones (A = ficha 0, B = ficha 1). */
const twoOptions = (): GameState => ({ ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });
/** Turno de Brava con un 3 y una sola ficha fuera: una opción. */
const oneOption = (): GameState => ({ ...setup({ pink: [20, -1, -1, -1] }, CHARACTER_IDS), turn: BRAVA, dice: 3 });

async function newGame(state: GameState) {
  const memory = createMemoryRepository();
  const game = await memory.repository.create(state);
  return { ...memory, id: game.id };
}

/** Cupo que siempre concede (F4): estas pruebas de F3 se centran en el selector, no en el cupo. */
const unlimitedQuota: MoveQuota = { tryConsume: async () => ({ kind: "allowed", used: 1 }) };

let tokens = 0;
function deps(repository: AdvanceDeps["repository"], extra: Partial<AdvanceDeps> = {}): AdvanceDeps {
  return { repository, rollDie: () => 4, newToken: () => `token-${++tokens}`, moveQuota: unlimitedQuota, ...extra };
}

/** Selector real de F2 con un fetch simulado. */
function realSelector(respond: () => Response | "hang" | "network", extra: { breaker?: MoveBreaker; timeoutMs?: number } = {}) {
  const calls: unknown[] = [];
  const failures: MoveLlmError[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init!.body)));
    const r = respond();
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "hang") return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    return r;
  });
  const selector = createMoveSelector({
    config,
    fetch: fetch as unknown as typeof globalThis.fetch,
    breaker: extra.breaker ?? createMoveBreaker(),
    timeoutMs: extra.timeoutMs,
    onFailure: (e) => failures.push(e),
  });
  return { selector, calls, failures };
}
const answer = (content: string, finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content } }] });

/** La jugada local en un estado (lo que haría `chooseMove`). */
const localPiece = (state: GameState) => chooseMove(state, getAvailableMoves(state));

describe("F3: selector activado", () => {
  it("con dos opciones, aplica la elección válida del LLM (distinta de la local) sin usar la estrategia local", async () => {
    const state = twoOptions();
    const local = localPiece(state);
    const other = local === 0 ? "B" : "A";
    const otherPiece = local === 0 ? 1 : 0;
    const { repository, id, rows } = await newGame(state);
    const s = realSelector(() => answer(`{"choice":"${other}"}`));
    localCalls.count = 0;
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", playerId: BRAVA, pieceIndex: otherPiece } });
    expect(s.calls).toHaveLength(1);
    expect(localCalls.count).toBe(0);
    // Lo guardado es exactamente lo que da el motor con esa jugada.
    const expected = applyAction(state, { type: "move", playerId: BRAVA, pieceIndex: otherPiece });
    expect(expected.ok && rows.get(id)!.game.state).toEqual(expected.ok ? expected.state : null);
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 2 } });
  });

  it("con una sola opción, la elige directamente sin llamar al LLM", async () => {
    const { repository, id } = await newGame(oneOption());
    const s = realSelector(() => answer('{"choice":"A"}'));
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: 0 } });
    expect(s.calls).toHaveLength(0);
  });

  it("no se llama al LLM para tirar el dado ni cuando la tirada no deja movimientos", async () => {
    const s = realSelector(() => answer('{"choice":"A"}'));
    // Tirada (sin dado ni bonus).
    const roll = await newGame(createGame([...CHARACTER_IDS]));
    expect(await advanceGame(roll.id, 1, deps(roll.repository, { moveSelector: s.selector, rollDie: () => 3 }))).toMatchObject({
      kind: "advanced",
      action: { type: "roll", value: 3 },
      events: [{ type: "dice_rolled" }, { type: "no_moves" }, { type: "turn_changed" }],
    });
    expect(s.calls).toHaveLength(0);
  });

  it("selector desactivado (sin moveSelector): se usa chooseMove, como siempre", async () => {
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    localCalls.count = 0;
    const result = await advanceGame(id, 1, deps(repository));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(localCalls.count).toBe(1);
  });
});

describe("F3: cualquier fallo del selector → estrategia local exactamente una vez", () => {
  const cases: [string, () => ReturnType<typeof realSelector>, string][] = [
    ["timeout", () => realSelector(() => "hang", { timeoutMs: 20 }), "timeout"],
    ["error HTTP 500", () => realSelector(() => new Response("{}", { status: 500 })), "http"],
    ["error HTTP 429", () => realSelector(() => new Response("{}", { status: 429 })), "http"],
    ["error de red", () => realSelector(() => "network"), "network"],
    ["respuesta inválida", () => realSelector(() => answer("Elijo la B")), "invalid_response"],
    ["identificador inexistente", () => realSelector(() => answer('{"choice":"C"}')), "invalid_response"],
    ["respuesta truncada", () => realSelector(() => answer('{"choice":"A"}', "length")), "invalid_response"],
  ];

  it.each(cases)("%s: avanza con la jugada local, una sola vez, y libera la reserva", async (_, make, kind) => {
    const state = twoOptions();
    const { repository, id, rows } = await newGame(state);
    const s = make();
    const reasons: MoveFallbackReason[] = [];
    localCalls.count = 0;
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: s.selector, onMoveFallback: (r) => reasons.push(r) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(localCalls.count).toBe(1);
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].kind).toBe(kind);
    expect(reasons).toEqual(["fallo del selector"]);
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 2 } });
  });

  it("circuito abierto: estrategia local una vez, sin llamar al selector (F4: ni se consume cupo)", async () => {
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    const s = realSelector(() => answer('{"choice":"A"}'), { breaker: { blockedUntil: Number.MAX_SAFE_INTEGER } });
    const reasons: MoveFallbackReason[] = [];
    let consumed = 0;
    localCalls.count = 0;
    const result = await advanceGame(
      id,
      1,
      deps(repository, { moveSelector: s.selector, onMoveFallback: (r) => reasons.push(r), moveQuota: { tryConsume: async () => (consumed++, { kind: "allowed", used: consumed }) } }),
    );
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(localCalls.count).toBe(1);
    expect(s.calls).toHaveLength(0);
    expect(consumed).toBe(0);
    expect(reasons).toEqual(["fallo del selector"]);
  });

  it("cancelación de la petición: estrategia local una vez y la partida avanza", async () => {
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    const s = realSelector(() => "hang", { timeoutMs: 3_000 });
    const controller = new AbortController();
    localCalls.count = 0;
    const pending = advanceGame(id, 1, deps(repository, { moveSelector: s.selector, signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(localCalls.count).toBe(1);
    expect(s.failures.map((f) => f.kind)).toEqual(["aborted"]);
  });
});

describe("F3: la elección se valida contra la decisión y el estado reservado", () => {
  const fixed = (result: Awaited<ReturnType<MoveSelector["select"]>>): MoveSelector => ({ select: async () => result });

  it.each([
    ["identificador y ficha que no se corresponden", fixed({ ok: true, id: "B", pieceIndex: 0 })],
    ["identificador de otra decisión", fixed({ ok: true, id: "C", pieceIndex: 1 })],
    ["ficha que no es de ninguna opción", fixed({ ok: true, id: "A", pieceIndex: 2 })],
  ])("%s → opción no válida, estrategia local una vez", async (_, selector) => {
    const state = twoOptions();
    const { repository, id } = await newGame(state);
    const reasons: MoveFallbackReason[] = [];
    localCalls.count = 0;
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: selector, onMoveFallback: (r) => reasons.push(r) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(reasons).toEqual(["opción no válida"]);
    expect(localCalls.count).toBe(1);
  });

  it("movimiento ilegal (un selector que altera la decisión): nunca se aplica; se usa la jugada local", async () => {
    const state = twoOptions();
    const { repository, id, rows } = await newGame(state);
    // Selector malicioso: cambia la ficha de la opción A por la 2, que está en casa (ilegal con un 3).
    const evil: MoveSelector = {
      select: async (_s, decision) => {
        decision.options[0].pieceIndex = 2;
        return { ok: true, id: "A", pieceIndex: 2 };
      },
    };
    const reasons: MoveFallbackReason[] = [];
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: evil, onMoveFallback: (r) => reasons.push(r) }));
    expect(reasons).toEqual(["movimiento ilegal"]);
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    if (result.kind !== "advanced" || result.action.type !== "move") return;
    expect(getAvailableMoves(state)).toContain(result.action.pieceIndex);
    expect(rows.get(id)!.game.state.players[0].pieces[2].state).toBe("base");
  });

  it("un selector que lanza (no debería): estrategia local, la partida avanza y la reserva queda libre", async () => {
    const state = twoOptions();
    const { repository, id, rows } = await newGame(state);
    const throwing: MoveSelector = {
      select: async () => {
        throw new Error("fallo inesperado");
      },
    };
    const reasons: MoveFallbackReason[] = [];
    localCalls.count = 0;
    const result = await advanceGame(id, 1, deps(repository, { moveSelector: throwing, onMoveFallback: (r) => reasons.push(r) }));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", pieceIndex: localPiece(state) } });
    expect(reasons).toEqual(["excepción del selector"]);
    expect(localCalls.count).toBe(1);
    expect(rows.get(id)).toMatchObject({ lockToken: null, processingUntil: null, game: { version: 2 } });
  });

  it("si la estrategia local también falla tras el selector, se libera la reserva y no se altera el estado", async () => {
    const state = twoOptions();
    const { repository, id, rows, calls } = await newGame(state);
    const failing: MoveSelector = { select: async () => ({ ok: false, error: new MoveLlmError("network", "sin conexión con AI Gateway") }) };
    // Un azar que lanza solo afecta a Chispa; aquí se fuerza el fallo con un estado de Chispa.
    const chispaState: GameState = { ...setup({ blue: [20, 30, -1, -1] }, CHARACTER_IDS), turn: CHARACTER_IDS[3], dice: 3 };
    const chispa = await newGame(chispaState);
    const boom = () => {
      throw new Error("fallo del azar");
    };
    await expect(advanceGame(chispa.id, 1, deps(chispa.repository, { moveSelector: failing, random: boom }))).rejects.toThrow("fallo del azar");
    expect(chispa.calls.release).toBe(1);
    expect(chispa.rows.get(chispa.id)).toMatchObject({ lockToken: null, game: { version: 1, state: chispaState } });
    // La partida de Brava (sin azar) no se ve afectada.
    expect(await advanceGame(id, 1, deps(repository, { moveSelector: failing }))).toMatchObject({ kind: "advanced" });
    expect(calls.release).toBe(0);
    expect(rows.get(id)!.game.version).toBe(2);
  });
});

describe("F3: una respuesta antigua nunca se aplica", () => {
  it("reserva caducada mientras responde el LLM: lease_expired y nada guardado", async () => {
    const state = twoOptions();
    const { repository, id, rows, clock } = await newGame(state);
    const slow: MoveSelector = {
      select: async (_s, decision) => {
        clock.now += LEASE_MS + 1;
        return { ok: true, id: decision.options[1].id, pieceIndex: decision.options[1].pieceIndex };
      },
    };
    expect(await advanceGame(id, 1, deps(repository, { moveSelector: slow }))).toEqual({ kind: "lease_expired" });
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 1, state, lastAction: null } });
  });

  it("otro proceso avanza tras caducar la reserva: la respuesta tardía no se aplica sobre la versión nueva", async () => {
    const state = twoOptions();
    const { repository, id, rows, clock } = await newGame(state);
    let otherResult: unknown;
    const slow: MoveSelector = {
      select: async (_s, decision) => {
        clock.now += LEASE_MS + 1;
        // Mientras tanto, otra petición (sin selector) reserva y confirma la versión 2.
        otherResult = await advanceGame(id, 1, deps(repository));
        return { ok: true, id: decision.options[1].id, pieceIndex: decision.options[1].pieceIndex };
      },
    };
    expect(await advanceGame(id, 1, deps(repository, { moveSelector: slow }))).toEqual({ kind: "lease_expired" });
    expect(otherResult).toMatchObject({ kind: "advanced", game: { version: 2 } });
    // Lo guardado es la jugada del otro proceso, no la respuesta tardía.
    const saved = rows.get(id)!.game;
    expect(saved.version).toBe(2);
    expect(saved.lastAction).toEqual((otherResult as { action: unknown }).action);
  });

  it("reintento con una versión antigua: version_conflict sin consultar al selector", async () => {
    const { repository, id } = await newGame(twoOptions());
    const s = realSelector(() => answer('{"choice":"A"}'));
    await advanceGame(id, 1, deps(repository, { moveSelector: s.selector }));
    expect(s.calls).toHaveLength(1);
    expect(await advanceGame(id, 1, deps(repository, { moveSelector: s.selector }))).toEqual({ kind: "version_conflict", currentVersion: 2 });
    expect(s.calls).toHaveLength(1);
  });
});

describe("F3: partidas completas", () => {
  /** Juega una partida entera con avances sucesivos y devuelve sus acciones. */
  async function play(seed: number, moveSelector?: MoveSelector) {
    const dice = createSeededRandom(seed);
    const random = createSeededRandom(seed + 1000);
    const { repository, id } = await newGame(createGame([...CHARACTER_IDS]));
    const actions: unknown[] = [];
    for (let version = 1; version < 3000; version++) {
      const result = await advanceGame(id, version, deps(repository, { moveSelector, rollDie: () => 1 + Math.floor(dice() * 6), random }));
      if (result.kind === "game_finished") break;
      if (result.kind !== "advanced") throw new Error(result.kind);
      actions.push(result.action);
    }
    return actions;
  }

  it("con un selector que siempre falla, la partida es idéntica a la de sin selector (tiradas, turnos, bonus y reglas)", { timeout: 60_000 }, async () => {
    let selects = 0;
    const failing: MoveSelector = {
      select: async () => {
        selects++;
        return { ok: false, error: new MoveLlmError("http", "AI Gateway respondió 503", 503) };
      },
    };
    const without = await play(7);
    const withFailing = await play(7, failing);
    expect(withFailing).toEqual(without);
    expect(selects).toBeGreaterThan(0);
  });

  it("con un selector que elige siempre la última opción: solo se le consulta con 2+ opciones legales y todas las jugadas son legales", { timeout: 60_000 }, async () => {
    const seen: { legal: number; dice: number | null; bonus: boolean }[] = [];
    const last: MoveSelector = {
      select: async (state, decision) => {
        seen.push({ legal: getAvailableMoves(state).length, dice: state.dice, bonus: state.pendingBonus !== null });
        const option = decision.options[decision.options.length - 1];
        return { ok: true, id: option.id, pieceIndex: option.pieceIndex };
      },
    };
    const actions = await play(9, last);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.legal >= 2 && (s.dice !== null || s.bonus))).toBe(true);
    expect(actions.length).toBeGreaterThan(100);
  });
});
