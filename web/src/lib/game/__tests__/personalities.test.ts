import { describe, expect, it } from "vitest";
import {
  COLORS,
  MAIN_TRACK_SIZE,
  START_POSITIONS,
  applyAction,
  createGame,
  getAvailableMoves,
  type Color,
  type GameState,
  type PlayerId,
} from "@/lib/engine";
import { candidateMoves, chooseMove, createSeededRandom, decideAction, scoreMove, type RandomSource } from "../ai";
import {
  CHARACTERS,
  CHARACTER_IDS,
  CHARACTER_NAMES,
  MAX_RANDOMNESS,
  NEUTRAL_STRATEGY,
  getStrategy,
  type StrategyProfile,
} from "../characters";

const [BRAVA, ERNESTO, PILAR, CHISPA] = CHARACTERS;
const stepsAt = (color: Color, cell: number) => (cell - START_POSITIONS[color] + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;

/** Partida con las fichas colocadas (steps por color; −1 = casa). `ids` decide qué personaje lleva cada color. */
function setup(pieces: Partial<Record<Color, number[]>>, ids: readonly PlayerId[] = CHARACTER_IDS): GameState {
  const state = createGame([...ids]);
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

const choose = (state: GameState, strategy: StrategyProfile) => chooseMove(state, getAvailableMoves(state), { strategy });

// Escenarios (turno de rosa; la salida de rosa es la casilla 39).

/** Dado 3. Ficha 0: captura en la 52, pero con dos rivales justo detrás. Ficha 1: casilla segura 63. */
const captureOrSafety = (ids?: readonly PlayerId[]) =>
  rolled(
    setup(
      {
        pink: [10, 21, -1, -1],
        purple: [stepsAt("purple", 52), -1, -1, -1],
        blue: [stepsAt("blue", 50), stepsAt("blue", 48), -1, -1],
      },
      ids,
    ),
    3,
  );

/** Dado 4. Ficha 0: forma barrera en la 43. Ficha 1: casilla segura 46. Ficha 2: casilla normal 47. */
const barrierOrSafety = () => rolled(setup({ pink: [0, 3, 4, -1] }), 4);

/** Dado 2. Ficha 0: queda 3 casillas detrás de una ficha verde (64). Ficha 1: casilla segura 46. */
const huntOrSafety = () => rolled(setup({ pink: [20, 5, -1, -1], green: [stepsAt("green", 64), -1, -1, -1] }), 2);

describe("catálogo de personajes", () => {
  it("conserva ids, orden de colores y nombres", () => {
    expect(CHARACTER_IDS).toEqual(["ai-pink", "ai-purple", "ai-green", "ai-blue"]);
    expect(CHARACTERS.map((c) => c.color)).toEqual([...COLORS]);
    expect(CHARACTER_NAMES).toEqual({
      "ai-pink": "Brava",
      "ai-purple": "Don Ernesto",
      "ai-green": "Abuela Pilar",
      "ai-blue": "Chispa",
    });
  });

  it("solo Chispa tiene azar, y como mucho del 15 %", () => {
    expect(CHARACTERS.filter((c) => c.strategy.randomness > 0).map((c) => c.id)).toEqual(["ai-blue"]);
    expect(CHISPA.strategy.randomness).toBe(MAX_RANDOMNESS);
    expect(MAX_RANDOMNESS).toBe(0.15);
  });

  it("los perfiles son distintos entre sí y un jugador desconocido usa el neutro", () => {
    const keys = CHARACTERS.map((c) => JSON.stringify(c.strategy));
    expect(new Set(keys).size).toBe(4);
    expect(getStrategy("ai-green")).toBe(PILAR.strategy);
    expect(getStrategy("rosa")).toBe(NEUTRAL_STRATEGY);
  });
});

describe("estilos de juego diferenciados", () => {
  it("captura arriesgada: Brava, Don Ernesto y Chispa capturan; Pilar se va al seguro", () => {
    const state = captureOrSafety();
    expect(getAvailableMoves(state)).toEqual([0, 1]);
    expect(choose(state, BRAVA.strategy)).toBe(0);
    expect(choose(state, ERNESTO.strategy)).toBe(0);
    expect(choose(state, CHISPA.strategy)).toBe(0);
    expect(choose(state, PILAR.strategy)).toBe(1);
  });

  it("barrera contra seguro: Don Ernesto forma la barrera; Pilar y Chispa prefieren el seguro", () => {
    const state = barrierOrSafety();
    expect(getAvailableMoves(state)).toEqual([0, 1, 2]);
    expect(choose(state, ERNESTO.strategy)).toBe(0);
    expect(choose(state, PILAR.strategy)).toBe(1);
    expect(choose(state, CHISPA.strategy)).toBe(1);
  });

  it("caza: Brava se acerca a un rival; los demás prefieren el seguro", () => {
    const state = huntOrSafety();
    expect(choose(state, BRAVA.strategy)).toBe(0);
    expect(choose(state, ERNESTO.strategy)).toBe(1);
    expect(choose(state, PILAR.strategy)).toBe(1);
    expect(choose(state, CHISPA.strategy)).toBe(1);
  });

  it("decideAction usa el perfil del jugador en turno (por id, no por color)", () => {
    // Mismas fichas rosas; en la segunda partida el color rosa lo lleva ai-green (Pilar).
    expect(decideAction(captureOrSafety(), () => 1)).toEqual({ type: "move", playerId: "ai-pink", pieceIndex: 0 });
    const pilarOnPink = captureOrSafety(["ai-green", "ai-purple", "ai-pink", "ai-blue"]);
    expect(decideAction(pilarOnPink, () => 1)).toEqual({ type: "move", playerId: "ai-green", pieceIndex: 1 });
  });

  it("los tres deterministas eligen siempre lo mismo para el mismo estado", () => {
    for (const make of [captureOrSafety, barrierOrSafety, huntOrSafety]) {
      for (const c of [BRAVA, ERNESTO, PILAR]) {
        const state = make();
        const first = chooseMove(state, getAvailableMoves(state), { strategy: c.strategy, random: Math.random });
        for (let i = 0; i < 20; i++) {
          expect(chooseMove(state, getAvailableMoves(state), { strategy: c.strategy, random: Math.random })).toBe(first);
        }
      }
    }
  });
});

describe("azar acotado de Chispa", () => {
  const s = (pairs: Array<[number, number]>) => pairs.map(([index, score]) => ({ index, score }));

  it("candidatas: como mucho un 15 % por debajo de la mejor, también con puntuaciones negativas o cero", () => {
    expect(candidateMoves(s([[0, 1000], [1, 850], [2, 849]]), 0.15)).toEqual([0, 1]);
    expect(candidateMoves(s([[0, -100], [1, -115], [2, -116]]), 0.15)).toEqual([0, 1]);
    expect(candidateMoves(s([[0, 0], [1, 0], [2, -1]]), 0.15)).toEqual([0, 1]);
    expect(candidateMoves(s([[3, 50], [1, 50], [2, 10]]), 0)).toEqual([1, 3]);
    expect(candidateMoves(s([[0, Number.NEGATIVE_INFINITY], [1, 5]]), 0.15)).toEqual([1]);
    expect(candidateMoves(s([[0, Number.NEGATIVE_INFINITY]]), 0.15)).toEqual([]);
    expect(candidateMoves(s([[0, 100], [1, 0]]), 5)).toEqual([0, 1]); // el margen nunca pasa del 100 %
  });

  it("con la misma semilla elige lo mismo; con semillas distintas reparte entre empates", () => {
    const state = rolled(createGame([...CHARACTER_IDS]), 5); // las 4 salidas puntúan igual
    const picks = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 30 }, () => chooseMove(state, getAvailableMoves(state), { strategy: CHISPA.strategy, random }));
    };
    expect(picks(7)).toEqual(picks(7));
    expect(new Set(picks(7))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("nunca elige una jugada fuera del margen, aunque el azar devuelva valores extremos", () => {
    const state = barrierOrSafety(); // Chispa: solo la ficha 1 está dentro del 15 %
    for (const r of [0, 0.5, 0.999999, 1, -1, Number.NaN]) {
      expect(chooseMove(state, getAvailableMoves(state), { strategy: CHISPA.strategy, random: () => r })).toBe(1);
    }
  });

  it("sin fuente de azar, Chispa también es determinista", () => {
    const state = rolled(createGame([...CHARACTER_IDS]), 5);
    expect(chooseMove(state, getAvailableMoves(state), { strategy: CHISPA.strategy })).toBe(0);
  });
});

describe("legalidad", () => {
  it("chooseMove ignora índices que el motor no permite y falla si no queda ninguno", () => {
    const state = huntOrSafety(); // legales: 0 y 1 (2 y 3 están en casa con un 2)
    expect(getAvailableMoves(state)).toEqual([0, 1]);
    expect(chooseMove(state, [3, 2, 1], { strategy: BRAVA.strategy })).toBe(1);
    expect(() => chooseMove(state, [2, 3, 9, -1])).toThrow("legales");
  });

  /** Juega partidas completas; en cada decisión comprueba legalidad y que la elección respeta el perfil. */
  function play(seed: number, check = true) {
    let dieSeed = seed;
    const die = () => 1 + Math.floor((((dieSeed = (dieSeed * 16807) % 2147483647) - 1) / 2147483646) * 6);
    const random: RandomSource = createSeededRandom(seed);
    let state = createGame([...CHARACTER_IDS]);
    let chispaUnlikeDeterministic = 0;
    let actions = 0;
    while (state.status === "playing") {
      if (++actions > 20_000) throw new Error("la partida no termina");
      const action = decideAction(state, die, random);
      if (check && action.type === "move") {
        const legal = getAvailableMoves(state);
        expect(legal).toContain(action.pieceIndex);
        const strategy = getStrategy(state.turn);
        const scores = legal.map((i) => scoreMove(state, i, strategy));
        const best = Math.max(...scores);
        const chosen = scoreMove(state, action.pieceIndex, strategy);
        if (strategy.randomness === 0) {
          expect(chosen).toBe(best);
        } else {
          expect(chosen).toBeGreaterThanOrEqual(best - strategy.randomness * Math.abs(best));
          const deterministic = chooseMove(state, legal, { strategy });
          if (action.pieceIndex !== deterministic) chispaUnlikeDeterministic++;
        }
      }
      const result = applyAction(state, action);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      state = result.state;
    }
    return { state, chispaUnlikeDeterministic };
  }

  it("partidas completas: solo jugadas legales, deterministas en su óptimo y Chispa dentro del 15 %", () => {
    let unlike = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const { state, chispaUnlikeDeterministic } = play(seed);
      expect(state.ranking).toHaveLength(4);
      unlike += chispaUnlikeDeterministic;
    }
    // El azar de Chispa se nota: a menudo no elige lo que elegiría el desempate determinista.
    expect(unlike).toBeGreaterThan(20);
  });

  it("una partida con la misma semilla (dado y azar) es idéntica", () => {
    expect(play(42, false).state).toEqual(play(42, false).state);
  });
});
