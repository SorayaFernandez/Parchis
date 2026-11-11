import { describe, expect, it } from "vitest";
import {
  FINAL_POSITION,
  HOME_ENTRY_STEPS,
  applyAction,
  createGame,
  type GameAction,
  type GameEvent,
  type GameState,
} from "@/lib/engine";
import { describeEvent } from "../events";
import { PIECE_JOURNEY, getPlayerSummaries, getTurnInfo, pieceProgress } from "../summary";

const IDS = ["rosa", "morado", "verde", "azul"];
const NAMES = { rosa: "Rosa", morado: "Morado", verde: "Verde", azul: "Azul" };

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

function withSteps(state: GameState, playerIndex: number, steps: number[]): GameState {
  const next = structuredClone(state);
  next.players[playerIndex].pieces = steps.map((s, i) => ({
    steps: s,
    state: s < 0 ? "base" : s === FINAL_POSITION ? "finished" : s >= 68 ? "final" : "track",
    arrivalOrder: i + 1,
  }));
  return next;
}

describe("progreso de las fichas", () => {
  it("cuenta 71 casillas de la salida a la meta (63 de recorrido + 8 de tramo final)", () => {
    expect(PIECE_JOURNEY).toBe(71);
    expect(pieceProgress({ steps: -1 })).toBe(0);
    expect(pieceProgress({ steps: 0 })).toBe(0);
    expect(pieceProgress({ steps: HOME_ENTRY_STEPS })).toBe(63);
    expect(pieceProgress({ steps: 68 })).toBe(64); // 1ª casilla de color
    expect(pieceProgress({ steps: 74 })).toBe(70);
    expect(pieceProgress({ steps: FINAL_POSITION })).toBe(71);
  });
});

describe("resumen de jugadores", () => {
  it("al empezar: todos en casa, progreso 0 y pink en turno", () => {
    const summaries = getPlayerSummaries(createGame(IDS));
    expect(summaries.map((s) => [s.id, s.color, s.status])).toEqual([
      ["rosa", "pink", "turn"],
      ["morado", "purple", "waiting"],
      ["verde", "green", "waiting"],
      ["azul", "blue", "waiting"],
    ]);
    expect(summaries.every((s) => s.progress === 0 && s.pieces.base === 4)).toBe(true);
  });

  it("cuenta fichas por zona y calcula el progreso", () => {
    const state = withSteps(createGame(IDS), 0, [-1, 10, 70, FINAL_POSITION]);
    const [rosa] = getPlayerSummaries(state);
    expect(rosa.pieces).toEqual({ base: 1, track: 1, final: 1, finished: 1 });
    expect(rosa.progress).toBe(Math.round(((0 + 10 + 66 + 71) / (71 * 4)) * 100));
  });

  it("muestra el puesto de quien ha terminado y el ganador", () => {
    let state = withSteps(createGame(["rosa", "morado"]), 0, [75, 75, 75, 70]);
    state = act(state, { type: "roll", playerId: "rosa", value: 5 });
    state = act(state, { type: "move", playerId: "rosa", pieceIndex: 3 });
    const [rosa, morado] = getPlayerSummaries(state);
    expect(rosa).toMatchObject({ status: "finished", place: 1, progress: 100 });
    expect(morado).toMatchObject({ status: "finished", place: 2 });
    expect(getTurnInfo(state).phase).toEqual({ kind: "finished", winner: "rosa" });
  });
});

describe("información del turno", () => {
  it("fase de tirar: se puede lanzar", () => {
    const turn = getTurnInfo(createGame(IDS));
    expect(turn).toMatchObject({ playerId: "rosa", color: "pink", phase: { kind: "roll" }, canRoll: true, lastDice: null });
  });

  it("fase de mover: dado y fichas movibles del motor; no se puede lanzar", () => {
    const state = act(createGame(IDS), { type: "roll", playerId: "rosa", value: 5 });
    expect(getTurnInfo(state)).toMatchObject({
      phase: { kind: "move", dice: 5, movablePieces: [0, 1, 2, 3] },
      canRoll: false,
      lastDice: 5,
    });
  });

  it("fase de bonus: cantidad, motivo y si después repite tirada", () => {
    // rosa en steps 10 con un 6 captura a morado en la casilla 55.
    let state = withSteps(createGame(IDS), 0, [10, -1, -1, -1]);
    state = withSteps(state, 1, [50, -1, -1, -1]);
    state = act(state, { type: "roll", playerId: "rosa", value: 6 });
    state = act(state, { type: "move", playerId: "rosa", pieceIndex: 0 });
    expect(getTurnInfo(state)).toMatchObject({
      phase: { kind: "bonus", amount: 20, reason: "capture", rollAgain: true, movablePieces: [0] },
      canRoll: false,
      sixesInTurn: 1,
      maxSixes: 3,
    });
  });
});

describe("texto de los eventos", () => {
  const cases: [GameEvent, string | null][] = [
    [{ type: "dice_rolled", playerId: "rosa", value: 4 }, "Rosa saca un 4"],
    [{ type: "no_moves", playerId: "rosa", value: 4 }, "Rosa no puede mover con un 4"],
    [
      { type: "piece_moved", playerId: "rosa", pieceIndex: 0, distance: 5, from: { state: "base", steps: -1 }, to: { state: "track", steps: 0 }, withBonus: false },
      "Rosa saca una ficha de casa",
    ],
    [
      { type: "piece_moved", playerId: "rosa", pieceIndex: 0, distance: 20, from: { state: "track", steps: 3 }, to: { state: "track", steps: 23 }, withBonus: true },
      "Rosa avanza 20 de bonus",
    ],
    [{ type: "piece_captured", playerId: "rosa", victimId: "azul", victimPieceIndex: 1, cell: 52 }, "Rosa captura una ficha de Azul"],
    [{ type: "bonus_granted", playerId: "rosa", amount: 10, reason: "goal" }, "Bonus de +10 para Rosa"],
    [{ type: "third_six_penalty", playerId: "rosa", pieceIndex: 2 }, "Tercer 6 de Rosa: su última ficha vuelve a casa"],
    [{ type: "third_six_penalty", playerId: "rosa", pieceIndex: null }, "Tercer 6 de Rosa: pierde el turno"],
    [{ type: "player_finished", playerId: "verde", place: 2 }, "Verde termina en 2º lugar"],
    [{ type: "game_finished", winner: "morado", ranking: ["morado", "rosa"] }, "Fin de la partida: gana Morado"],
    [{ type: "turn_changed", playerId: "azul" }, null],
  ];

  it.each(cases)("%o", (event, text) => {
    expect(describeEvent(event, NAMES)).toBe(text);
  });

  it("usa el id si no hay nombre", () => {
    expect(describeEvent({ type: "roll_again", playerId: "x" }, NAMES)).toBe("x vuelve a tirar");
  });
});
