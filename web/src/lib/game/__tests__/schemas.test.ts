import { describe, expect, it } from "vitest";
import { applyAction, createGame, getAvailableMoves, type GameAction, type GameState } from "@/lib/engine";
import { CHARACTERS, CHARACTER_IDS } from "../characters";
import { GameActionSchema, GameEventSchema, GameRowSchema, GameStateSchema, toStoredGame } from "../schemas";

const row = (state: GameState, extra: Record<string, unknown> = {}) => ({
  id: "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f",
  state,
  engine_version: 1,
  status: state.status,
  winner: state.winner,
  version: 1,
  lock_token: null,
  processing_until: null,
  last_action: null,
  last_events: [],
  created_at: "2026-11-10T20:00:00.123456+00:00",
  updated_at: "2026-11-10T20:00:00.123456+00:00",
  finished_at: null,
  ...extra,
});

describe("personajes", () => {
  it("cuatro ids estables, únicos y en el orden de colores del motor", () => {
    expect(CHARACTER_IDS).toEqual(["ai-pink", "ai-purple", "ai-green", "ai-blue"]);
    const state = createGame([...CHARACTER_IDS]);
    expect(state.players.map((p) => [p.id, p.color])).toEqual(CHARACTERS.map((c) => [c.id, c.color]));
  });
});

describe("GameStateSchema", () => {
  it("acepta todos los estados que produce el motor en partidas completas", () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let g = 0; g < 5; g++) {
      let state = createGame([...CHARACTER_IDS]);
      while (state.status === "playing") {
        const moves = getAvailableMoves(state);
        const action: GameAction =
          state.dice === null && state.pendingBonus === null
            ? { type: "roll", playerId: state.turn, value: 1 + Math.floor(random() * 6) }
            : { type: "move", playerId: state.turn, pieceIndex: moves[Math.floor(random() * moves.length)] };
        const result = applyAction(state, action);
        if (!result.ok) throw new Error(result.error);
        // Estado, acción y eventos tal como viajarían por JSON.
        const roundTrip = JSON.parse(JSON.stringify(result.state));
        expect(GameStateSchema.parse(roundTrip)).toEqual(result.state);
        expect(GameActionSchema.parse(JSON.parse(JSON.stringify(action)))).toEqual(action);
        for (const event of result.events) expect(GameEventSchema.parse(event)).toEqual(event);
        state = result.state;
      }
      expect(GameStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("rechaza estados corruptos", () => {
    const base = createGame([...CHARACTER_IDS]);
    const bad: [string, unknown][] = [
      ["no es objeto", "texto"],
      ["falta un campo", { ...base, turn: undefined }],
      ["color inválido", { ...base, players: base.players.map((p, i) => (i === 0 ? { ...p, color: "red" } : p)) }],
      ["3 fichas", { ...base, players: base.players.map((p, i) => (i === 0 ? { ...p, pieces: p.pieces.slice(1) } : p)) }],
      ["steps fuera de rango", { ...base, players: base.players.map((p, i) => (i === 0 ? { ...p, pieces: p.pieces.map((x) => ({ ...x, steps: 80 })) } : p)) }],
      ["dado 7", { ...base, dice: 7 }],
      ["turno de un desconocido", { ...base, turn: "nadie" }],
      ["terminada sin ganador", { ...base, status: "finished" }],
      ["un solo jugador", { ...base, players: base.players.slice(0, 1) }],
    ];
    for (const [label, value] of bad) expect(GameStateSchema.safeParse(value).success, label).toBe(false);
  });
});

describe("acciones y eventos", () => {
  it("rechaza acciones y eventos con formato incorrecto", () => {
    expect(GameActionSchema.safeParse({ type: "roll", playerId: "ai-pink", value: 0 }).success).toBe(false);
    expect(GameActionSchema.safeParse({ type: "move", playerId: "ai-pink", pieceIndex: 4 }).success).toBe(false);
    expect(GameActionSchema.safeParse({ type: "jump" }).success).toBe(false);
    expect(GameEventSchema.safeParse({ type: "dice_rolled", playerId: "ai-pink" }).success).toBe(false);
    expect(GameEventSchema.safeParse({ type: "third_six_penalty", playerId: "ai-pink", pieceIndex: null }).success).toBe(true);
  });
});

describe("GameRowSchema", () => {
  it("acepta una fila recién creada y la convierte a camelCase", () => {
    const state = createGame([...CHARACTER_IDS]);
    const stored = toStoredGame(GameRowSchema.parse(row(state)));
    expect(stored).toMatchObject({ version: 1, engineVersion: 1, status: "playing", winner: null, lastAction: null, lastEvents: [] });
    expect(stored.state).toEqual(state);
    expect(stored).not.toHaveProperty("lock_token");
    expect(stored).not.toHaveProperty("lockToken");
  });

  it("rechaza columnas generadas que no coinciden con el estado", () => {
    const state = createGame([...CHARACTER_IDS]);
    expect(GameRowSchema.safeParse(row(state, { status: "finished" })).success).toBe(false);
    expect(GameRowSchema.safeParse(row(state, { winner: "ai-pink" })).success).toBe(false);
  });

  it("rechaza id no UUID y last_events que no son eventos", () => {
    const state = createGame([...CHARACTER_IDS]);
    expect(GameRowSchema.safeParse(row(state, { id: "123" })).success).toBe(false);
    expect(GameRowSchema.safeParse(row(state, { last_events: [{ type: "x" }] })).success).toBe(false);
  });
});
