import { describe, expect, it } from "vitest";
import {
  START_POSITIONS,
  MAIN_TRACK_SIZE,
  applyAction,
  createGame,
  getAvailableMoves,
  type Color,
  type GameState,
} from "@/lib/engine";
import { chooseMove, decideAction, scoreMove } from "../ai";
import { CHARACTER_IDS } from "../characters";

const stepsAt = (color: Color, cell: number) => (cell - START_POSITIONS[color] + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;

/** Partida con las fichas colocadas (steps por color; −1 = casa). */
function setup(pieces: Partial<Record<Color, number[]>>): GameState {
  const state = createGame([...CHARACTER_IDS]);
  let order = 0;
  for (const player of state.players) {
    const steps = pieces[player.color];
    if (!steps) continue;
    player.pieces = steps.map((s) => ({
      steps: s,
      state: s < 0 ? "base" : s >= 75 ? "finished" : s >= 68 ? "final" : "track",
      arrivalOrder: ++order,
    }));
  }
  state.moveCounter = order;
  return state;
}

function rolled(state: GameState, value: number): GameState {
  const result = applyAction(state, { type: "roll", playerId: state.turn, value });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe("IA heurística", () => {
  it("prefiere capturar", () => {
    // pink: ficha 0 en steps 10 (+3 → casilla 52, donde hay una de purple); ficha 1 en steps 30.
    const state = rolled(setup({ pink: [10, 30, -1, -1], purple: [stepsAt("purple", 52), -1, -1, -1] }), 3);
    expect(getAvailableMoves(state)).toEqual([0, 1]);
    expect(chooseMove(state, [0, 1])).toBe(0);
  });

  it("prefiere sacar ficha de casa con un 5 antes que avanzar una sin peligro", () => {
    const state = rolled(setup({ pink: [30, -1, -1, -1] }), 5);
    expect(chooseMove(state, getAvailableMoves(state))).toBe(1);
  });

  it("prefiere llegar a la meta", () => {
    const state = rolled(setup({ pink: [72, 20, -1, -1] }), 3);
    expect(chooseMove(state, getAvailableMoves(state))).toBe(0);
  });

  it("evita dejar una ficha a tiro de un rival si hay otra opción", () => {
    // pink ficha 0: steps 20 → +4 = casilla 63 (segura); ficha 1: steps 2 → +4 = casilla 45 con un rival 1 casilla detrás.
    const blueBehind = stepsAt("blue", 44);
    const state = rolled(setup({ pink: [20, 2, -1, -1], blue: [blueBehind, -1, -1, -1] }), 4);
    expect(scoreMove(state, 0)).toBeGreaterThan(scoreMove(state, 1));
    expect(chooseMove(state, getAvailableMoves(state))).toBe(0);
  });

  it("solo elige entre los movimientos legales y desempata por el índice más bajo", () => {
    const state = rolled(createGame([...CHARACTER_IDS]), 5); // las 4 salidas puntúan igual
    expect(chooseMove(state, getAvailableMoves(state))).toBe(0);
    expect(chooseMove(state, [2, 3])).toBe(2);
  });
});

describe("decideAction", () => {
  it("sin dado: tira con el valor que da rollDie (no inventa dados)", () => {
    const state = createGame([...CHARACTER_IDS]);
    expect(decideAction(state, () => 4)).toEqual({ type: "roll", playerId: "ai-pink", value: 4 });
  });

  it("con dado: mueve una ficha legal; con bonus pendiente: también mueve", () => {
    const state = rolled(createGame([...CHARACTER_IDS]), 5);
    expect(decideAction(state, () => { throw new Error("no debe tirar"); })).toEqual({ type: "move", playerId: "ai-pink", pieceIndex: 0 });
    const bonus = {
      ...setup({ pink: [10, -1, -1, -1] }),
      pendingBonus: { playerId: "ai-pink", amount: 10, reason: "goal" as const, fromSix: false },
    };
    expect(decideAction(bonus, () => { throw new Error("no debe tirar"); })).toEqual({ type: "move", playerId: "ai-pink", pieceIndex: 0 });
  });

  it("con dado pero sin movimientos legales (estado anómalo): timeout para no bloquear la partida", () => {
    const stuck = { ...createGame([...CHARACTER_IDS]), dice: 3 }; // todas en casa con un 3
    expect(getAvailableMoves(stuck)).toEqual([]);
    expect(decideAction(stuck, () => 1)).toEqual({ type: "timeout" });
  });

  it("no decide nada en una partida terminada", () => {
    const finished = { ...createGame([...CHARACTER_IDS]), status: "finished" as const, winner: "ai-pink" };
    expect(() => decideAction(finished, () => 1)).toThrow("terminado");
  });

  it("cuatro IA juegan partidas completas solo con jugadas aceptadas por el motor", () => {
    let seed = 11;
    const die = () => 1 + Math.floor((((seed = (seed * 16807) % 2147483647) - 1) / 2147483646) * 6);
    for (let g = 0; g < 10; g++) {
      let state = createGame([...CHARACTER_IDS]);
      let actions = 0;
      while (state.status === "playing") {
        if (++actions > 20_000) throw new Error("la partida no termina");
        const result = applyAction(state, decideAction(state, die));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        state = result.state;
      }
      expect(state.ranking).toHaveLength(4);
      expect(state.winner).toBe(state.ranking[0]);
    }
  });
});
