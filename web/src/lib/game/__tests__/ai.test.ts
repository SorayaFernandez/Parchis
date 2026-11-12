import { describe, expect, it } from "vitest";
import {
  START_POSITIONS,
  MAIN_TRACK_SIZE,
  applyAction,
  canMovePiece,
  createGame,
  getAvailableMoves,
  getMoveDistance,
  isSafeCell,
  getBlockades,
  getLegalMoves,
  getRealBoardPosition,
  isOnMainTrack,
  type Color,
  type GameState,
} from "@/lib/engine";
import { chooseMove, createSeededRandom, decideAction, scoreMove } from "../ai";
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

describe("barreras: la IA y los bonus respetan las mismas reglas que el motor", () => {
  it("en partidas completas, ninguna jugada (de dado o de bonus) atraviesa ni cae en una barrera y nunca hay más de dos fichas por casilla", () => {
    let moves = 0;
    let bonusMoves = 0;
    for (let g = 0; g < 12; g++) {
      const random = createSeededRandom(500 + g);
      let state: GameState = createGame([...CHARACTER_IDS]);
      for (let i = 0; i < 4000 && state.status === "playing"; i++) {
        const action = decideAction(state, () => 1 + Math.floor(random() * 6), random);
        const result = applyAction(state, action);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        if (action.type === "move") {
          moves++;
          if (state.pendingBonus) bonusMoves++;
          const player = state.players.find((p) => p.id === action.playerId)!;
          const from = player.pieces[action.pieceIndex];
          const to = result.state.players.find((p) => p.id === action.playerId)!.pieces[action.pieceIndex];
          if (from.steps >= 0 && isOnMainTrack(from)) {
            const blocked = new Set(getBlockades(state).map((b) => b.cell));
            const start = getRealBoardPosition(player.color, from.steps);
            for (let s = from.steps + 1; s <= Math.min(to.steps, 63); s++) {
              const cell = getRealBoardPosition(player.color, s);
              expect(cell !== start && blocked.has(cell), `${player.color} ${from.steps}→${to.steps} por ${cell}`).toBe(false);
            }
          }
        }
        const perCell = new Map<number, number>();
        for (const p of result.state.players) {
          for (const piece of p.pieces) {
            if (!isOnMainTrack(piece)) continue;
            const cell = getRealBoardPosition(p.color, piece.steps);
            perCell.set(cell, (perCell.get(cell) ?? 0) + 1);
          }
        }
        expect(Math.max(0, ...perCell.values())).toBeLessThanOrEqual(2);
        state = result.state;
      }
    }
    expect(moves).toBeGreaterThan(1000);
    expect(bonusMoves).toBeGreaterThan(0);
  }, 30_000);
});

describe("salida con 5 y apertura con 6: la IA recibe los mismos movimientos que el motor", () => {
  it("con un 5 y fichas en casa solo puede sacar ficha; con un 6 y una barrera propia, solo abrirla", () => {
    const exit = rolled(setup({ pink: [10, -1, -1, -1] }), 5);
    expect(getAvailableMoves(exit)).toEqual(getLegalMoves(exit, exit.turn, 5));
    expect(getAvailableMoves(exit)).toEqual([1, 2, 3]);
    expect(decideAction(exit, () => 1)).toMatchObject({ type: "move", pieceIndex: 1 });
    expect(() => chooseMove(exit, [0])).toThrow(); // una jugada que el motor no ofrece no se puede elegir

    const six = rolled(setup({ pink: [3, 3, 20, -1] }), 6);
    expect(getAvailableMoves(six)).toEqual(getLegalMoves(six, six.turn, 6));
    expect(getAvailableMoves(six)).toEqual([0, 1]);
    const action = decideAction(six, () => 1);
    expect(action.type === "move" && [0, 1].includes(action.pieceIndex)).toBe(true);
  });
});

/**
 * Oráculo independiente (no usa `getLegalMoves` ni `getBlockades`): movimientos válidos según
 * `canMovePiece`, filtrados por las dos obligaciones escritas desde la regla.
 */
function expectedMoves(state: GameState, distance: number): { moves: number[]; obligation: "exit" | "open" | null } {
  const player = state.players.find((p) => p.id === state.turn)!;
  const valid = [0, 1, 2, 3].filter((i) => canMovePiece(state, player.id, i, distance).ok);
  if (distance === 5) {
    const exits = valid.filter((i) => player.pieces[i].steps < 0);
    return exits.length > 0 ? { moves: exits, obligation: "exit" } : { moves: valid, obligation: null };
  }
  if (distance !== 6) return { moves: valid, obligation: null };
  const onTrack = (color: Color, steps: number) => steps >= 0 && steps < MAIN_TRACK_SIZE;
  const cellOf = (i: number) => (onTrack(player.color, player.pieces[i].steps) ? getRealBoardPosition(player.color, player.pieces[i].steps) : null);
  const inBarrier = (i: number) => {
    const cell = cellOf(i);
    if (cell === null) return false;
    const here = state.players.flatMap((p) => p.pieces.filter((x) => onTrack(p.color, x.steps) && getRealBoardPosition(p.color, x.steps) === cell).map(() => p.color));
    return isSafeCell(cell) ? here.length >= 2 : here.filter((c) => c === player.color).length >= 2;
  };
  const openings = valid.filter(inBarrier);
  return openings.length > 0 ? { moves: openings, obligation: "open" } : { moves: valid, obligation: null };
}

describe("obligaciones del 5 y del 6: motor, applyAction e IA coinciden con un oráculo independiente", () => {
  it("en partidas completas, getAvailableMoves = oráculo, la IA elige dentro y applyAction rechaza lo demás con su error", () => {
    const seen = { exit: 0, open: 0, mixedOpen: 0, rejectedExit: 0, rejectedOpen: 0, decisions: 0 };
    for (let g = 0; g < 15; g++) {
      const random = createSeededRandom(900 + g);
      let state: GameState = createGame([...CHARACTER_IDS]);
      for (let i = 0; i < 4000 && state.status === "playing"; i++) {
        const distance = getMoveDistance(state);
        if (distance !== null) {
          seen.decisions++;
          const { moves, obligation } = expectedMoves(state, distance);
          expect(getAvailableMoves(state), `dado ${distance}`).toEqual(moves);
          if (obligation) seen[obligation]++;
          if (obligation === "open") {
            const player = state.players.find((p) => p.id === state.turn)!;
            const cell = getRealBoardPosition(player.color, player.pieces[moves[0]].steps);
            if (state.players.some((p) => p.id !== player.id && p.pieces.some((x) => x.steps >= 0 && x.steps < MAIN_TRACK_SIZE && getRealBoardPosition(p.color, x.steps) === cell))) seen.mixedOpen++;
          }
          // Cualquier jugada válida por sí misma pero excluida por la obligación se rechaza con su error.
          const excluded = [0, 1, 2, 3].filter((k) => !moves.includes(k) && canMovePiece(state, state.turn, k, distance).ok);
          for (const k of excluded) {
            const result = applyAction(state, { type: "move", playerId: state.turn, pieceIndex: k });
            expect(result).toEqual({ ok: false, error: distance === 5 ? "MUST_EXIT_HOME" : "MUST_BREAK_BLOCKADE" });
            if (distance === 5) seen.rejectedExit++;
            else seen.rejectedOpen++;
          }
        }
        const action = decideAction(state, () => 1 + Math.floor(random() * 6), random);
        if (action.type === "move") expect(getAvailableMoves(state)).toContain(action.pieceIndex);
        const result = applyAction(state, action);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        state = result.state;
      }
    }
    // Que la prueba no sea vacía: las dos obligaciones aparecen y se rechazan jugadas excluidas.
    expect(seen.exit).toBeGreaterThan(50);
    expect(seen.open).toBeGreaterThan(5);
    expect(seen.rejectedExit).toBeGreaterThan(50);
    expect(seen.rejectedOpen).toBeGreaterThan(0);
  }, 60_000);
});
