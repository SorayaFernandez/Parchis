import { describe, expect, it } from "vitest";
import { getBlockades, getDistanceToHomeEntry, getRealBoardPosition, isSafeCell } from "../board";
import {
  FINAL_POSITION,
  FINAL_SECTION_SIZE,
  FINAL_STRETCH_SIZE,
  HOME_ENTRIES,
  HOME_ENTRY_STEPS,
  MAIN_TRACK_SIZE,
} from "../constants";
import { applyAction, createGame, getAvailableMoves } from "../engine";
import { canMovePiece, getLegalMoves } from "../moves";
import type { GameState } from "../types";
import { act, eventTypes, run, setup, steps, stepsForCell } from "./helpers";

const roll = (playerId: string, value: number) => ({ type: "roll" as const, playerId, value });
const move = (playerId: string, pieceIndex: number) => ({
  type: "move" as const,
  playerId,
  pieceIndex,
});

describe("creación de partida", () => {
  it("asigna colores en orden y empieza pink", () => {
    const state = createGame(["a", "b", "c", "d"]);
    expect(state.players.map((p) => p.color)).toEqual(["pink", "purple", "green", "blue"]);
    expect(state.turn).toBe("a");
    expect(state.status).toBe("playing");
    expect(state.players.every((p) => p.pieces.every((x) => x.state === "base"))).toBe(true);
  });

  it("rechaza menos de 2, más de 4 o ids repetidos", () => {
    expect(() => createGame(["a"])).toThrow(RangeError);
    expect(() => createGame(["a", "b", "c", "d", "e"])).toThrow(RangeError);
    expect(() => createGame(["a", "a"])).toThrow(RangeError);
  });
});

describe("validación de acciones", () => {
  it("no modifica el estado de entrada", () => {
    const state = setup({ pink: [10, -1, -1, -1] });
    const snapshot = structuredClone(state);
    const rolled = act(state, roll("pink", 3));
    act(rolled, move("pink", 0));
    expect(state).toEqual(snapshot);
  });

  it("rechaza turno ajeno, dado inválido, doble tirada y mover sin tirar", () => {
    const state = setup({ pink: [10, -1, -1, -1] });
    expect(applyAction(state, roll("blue", 3))).toEqual({ ok: false, error: "NOT_YOUR_TURN" });
    expect(applyAction(state, roll("pink", 7))).toEqual({ ok: false, error: "INVALID_DICE_VALUE" });
    expect(applyAction(state, roll("pink", 2.5))).toEqual({ ok: false, error: "INVALID_DICE_VALUE" });
    expect(applyAction(state, move("pink", 0))).toEqual({ ok: false, error: "ROLL_FIRST" });
    const rolled = act(state, roll("pink", 3));
    expect(applyAction(rolled, roll("pink", 3))).toEqual({ ok: false, error: "DICE_ALREADY_ROLLED" });
    expect(applyAction(rolled, move("pink", 9))).toEqual({ ok: false, error: "PIECE_NOT_FOUND" });
  });
});

describe("salida con 5", () => {
  it("con un 5 se puede sacar cualquier ficha a la casilla de salida", () => {
    const state = act(createGame([..."abcd"]), roll("a", 5));
    expect(getAvailableMoves(state)).toEqual([0, 1, 2, 3]);
    const result = run(state, move("a", 2));
    expect(result.state.players[0].pieces[2]).toMatchObject({ state: "track", steps: 0 });
    expect(result.state.turn).toBe("d"); // pink -> blue
  });

  it("sin 5 no hay movimientos y pasa el turno", () => {
    const result = run(createGame([..."abcd"]), roll("a", 4));
    expect(eventTypes(result)).toEqual(["dice_rolled", "no_moves", "turn_changed"]);
    expect(result.state.dice).toBeNull();
    expect(canMovePiece(result.state, "a", 0, 4)).toEqual({ ok: false, error: "NEED_FIVE_TO_EXIT" });
  });

  it("no se puede salir si hay una barrera propia en la salida", () => {
    const state = setup({ pink: [0, 0, -1, -1] });
    expect(canMovePiece(state, "pink", 2, 5)).toEqual({ ok: false, error: "OWN_BLOCKADE_ON_EXIT" });
  });

  it("una ficha propia en el pasillo final no cuenta como ocupando la salida (corrección)", () => {
    // steps 68 => (39 + 68) % 68 = 39: el original la contaba en la salida.
    const state = setup({ pink: [0, 68, -1, -1] });
    expect(canMovePiece(state, "pink", 2, 5)).toEqual({ ok: true });
  });

  it("al salir se captura una ficha rival en la salida, aunque sea casilla segura", () => {
    const blueSteps = stepsForCell("blue", 39);
    const state = act(setup({ blue: [blueSteps, -1, -1, -1] }), roll("pink", 5));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).toContain("piece_captured");
    expect(steps(result.state, "blue")[0]).toBe(-1);
  });

  it("al salir sobre una barrera rival se captura solo la ficha que llegó la última", () => {
    const b = stepsForCell("blue", 39);
    const state = act(setup({ blue: [b, b, -1, -1] }), roll("pink", 5));
    const result = run(state, move("pink", 0));
    // setup asigna arrivalOrder en orden: la ficha 1 de blue llegó la última.
    expect(steps(result.state, "blue").slice(0, 2)).toEqual([b, -1]);
  });

  it("la salida admite como máximo dos fichas", () => {
    const g = stepsForCell("green", 39);
    const b = stepsForCell("blue", 39);
    // pink + green en la salida: al salir se captura una, quedan 2: válido.
    expect(canMovePiece(setup({ pink: [0, -1, -1, -1], green: [g, -1, -1, -1] }), "pink", 1, 5).ok).toBe(true);
    // dos rivales distintos: se captura uno y quedan 1 + la nueva = 2: válido.
    expect(canMovePiece(setup({ green: [g, -1, -1, -1], blue: [b, -1, -1, -1] }), "pink", 0, 5).ok).toBe(true);
    // pink + dos rivales: quedan 1 + 1 + la nueva = 3: no válido.
    expect(
      canMovePiece(setup({ pink: [0, -1, -1, -1], green: [g, -1, -1, -1], blue: [b, -1, -1, -1] }), "pink", 1, 5),
    ).toEqual({ ok: false, error: "EXIT_FULL" });
  });
});

describe("movimientos", () => {
  it("avanza el valor del dado y pasa el turno", () => {
    const state = act(setup({ pink: [10, -1, -1, -1] }), roll("pink", 3));
    const result = run(state, move("pink", 0));
    expect(steps(result.state, "pink")[0]).toBe(13);
    expect(result.events[0]).toMatchObject({
      type: "piece_moved",
      from: { state: "track", steps: 10 },
      to: { state: "track", steps: 13 },
      distance: 3,
      withBonus: false,
    });
    expect(result.state.turn).toBe("blue");
  });

  it("con un 6 se vuelve a tirar", () => {
    const state = act(setup({ pink: [10, -1, -1, -1] }), roll("pink", 6));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).toContain("roll_again");
    expect(result.state.turn).toBe("pink");
    expect(result.state.dice).toBeNull();
  });

  it("con un 6 sin movimientos también se vuelve a tirar", () => {
    const result = run(createGame([..."abcd"]), roll("a", 6));
    expect(eventTypes(result)).toEqual(["dice_rolled", "no_moves", "roll_again"]);
    expect(result.state.turn).toBe("a");
  });

  it("solo se puede mover una ficha incluida en los movimientos legales", () => {
    const state = act(setup({ pink: [10, -1, -1, -1] }), roll("pink", 3));
    expect(applyAction(state, move("pink", 1))).toEqual({ ok: false, error: "NEED_FIVE_TO_EXIT" });
  });
});

describe("barreras", () => {
  const blueAt45 = stepsForCell("blue", 45);

  it("una barrera rival no se puede atravesar", () => {
    const state = setup({ pink: [3, -1, -1, -1], blue: [blueAt45, blueAt45, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 4)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    const result = run(state, roll("pink", 4));
    expect(eventTypes(result)).toEqual(["dice_rolled", "no_moves", "turn_changed"]);
  });

  it("tampoco se puede caer en la casilla de una barrera", () => {
    const state = setup({ pink: [0, -1, -1, -1], blue: [blueAt45, blueAt45, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 6)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
  });

  it("una barrera propia también bloquea, pero sus fichas pueden salir de ella", () => {
    const state = setup({ pink: [5, 5, 2, -1] });
    expect(canMovePiece(state, "pink", 2, 4)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    expect(canMovePiece(state, "pink", 0, 4)).toEqual({ ok: true });
  });

  it("con un 6 hay que abrir la barrera propia", () => {
    const state = act(setup({ pink: [5, 5, 20, -1] }), roll("pink", 6));
    expect(getAvailableMoves(state)).toEqual([0, 1]);
    expect(applyAction(state, move("pink", 2))).toEqual({ ok: false, error: "MUST_BREAK_BLOCKADE" });
  });

  it("con dos barreras propias se puede abrir cualquiera (el original solo miraba la primera)", () => {
    const state = act(setup({ pink: [5, 5, 20, 20] }), roll("pink", 6));
    expect(getAvailableMoves(state)).toEqual([0, 1, 2, 3]);
  });

  it("si la barrera no se puede abrir, se aplican las reglas normales del 6 (antes: sin movimientos)", () => {
    // La barrera pink está en la casilla 44; una barrera blue en la 50 impide abrirla con un 6.
    const b = stepsForCell("blue", 50);
    const state = setup({ pink: [5, 5, 20, -1], blue: [b, b, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 6)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    const result = run(state, roll("pink", 6));
    expect(eventTypes(result)).not.toContain("no_moves");
    expect(getAvailableMoves(result.state)).toEqual([2]);
  });
});

describe("barreras: regla definitiva (normal = mismo color; segura = cualquier color)", () => {
  // Casillas: 42 y 44 normales; 46, 34 (entrada de pink) y 56 (salida de blue) seguras.
  it("detección: mismo color en casilla normal sí; distinto color en normal no; en segura, cualquier pareja", () => {
    expect(isSafeCell(42) || isSafeCell(44)).toBe(false);
    expect(isSafeCell(46) && isSafeCell(34) && isSafeCell(56)).toBe(true);
    // Mismo color en casilla normal: barrera.
    expect(getBlockades(setup({ pink: [3, 3, -1, -1] }))).toEqual([{ color: "pink", cell: 42 }]);
    // Distinto color en casilla normal: no.
    expect(getBlockades(setup({ purple: [stepsForCell("purple", 44), -1, -1, -1], green: [stepsForCell("green", 44), -1, -1, -1] }))).toEqual([]);
    // Distinto color en casilla segura: barrera (sin color).
    expect(getBlockades(setup({ pink: [7, -1, -1, -1], blue: [stepsForCell("blue", 46), -1, -1, -1] }))).toEqual([{ color: null, cell: 46 }]);
    // Mismo color en casilla segura: barrera de ese color.
    expect(getBlockades(setup({ pink: [7, 7, -1, -1] }))).toEqual([{ color: "pink", cell: 46 }]);
    // Una sola ficha nunca es barrera; el pasillo final y la casa no cuentan.
    expect(getBlockades(setup({ pink: [7, 70, 70, -1], blue: [-1, -1, -1, -1] }))).toEqual([]);
  });

  const mixedAt46 = { purple: [stepsForCell("purple", 46), -1, -1, -1], green: [stepsForCell("green", 46), -1, -1, -1] };

  it("ninguna ficha, de ningún color, puede atravesar una barrera de dos colores en un seguro", () => {
    // pink en 43 (steps 4) con un 5 pasaría por 46.
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], ...mixedAt46 }), "pink", 0, 5)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    // blue en 44 con un 4 también pasaría por 46.
    const state = setup({ blue: [stepsForCell("blue", 44), -1, -1, -1], ...mixedAt46 });
    expect(canMovePiece(state, "blue", 0, 4)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    // Ni las fichas de los colores que la forman (purple desde 44).
    const own = setup({ purple: [stepsForCell("purple", 44), stepsForCell("purple", 46), -1, -1], green: mixedAt46.green });
    expect(canMovePiece(own, "purple", 0, 4)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    // Y una tirada que se queda antes de la barrera sí se puede.
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], ...mixedAt46 }), "pink", 0, 2)).toEqual({ ok: true });
  });

  it("ninguna ficha puede aterrizar sobre una barrera (de dos colores o de uno)", () => {
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], ...mixedAt46 }), "pink", 0, 3)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    const blueAt46 = stepsForCell("blue", 46);
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], blue: [blueAt46, blueAt46, -1, -1] }), "pink", 0, 3)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    expect(canMovePiece(setup({ pink: [4, 7, 7, -1] }), "pink", 0, 3)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
  });

  it("dos fichas de distinto color en una casilla normal no bloquean el paso", () => {
    const purple = stepsForCell("purple", 44);
    const green = stepsForCell("green", 44);
    // pink en 43 con un 2 pasa por 44 y cae en 45.
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], purple: [purple, -1, -1, -1], green: [green, -1, -1, -1] }), "pink", 0, 2)).toEqual({ ok: true });
  });

  it("caer en un seguro con una sola ficha rival está permitido: forma una barrera de dos colores, sin captura", () => {
    const blue = stepsForCell("blue", 46);
    const state = act(setup({ pink: [4, -1, -1, -1], blue: [blue, -1, -1, -1] }), roll("pink", 3));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).not.toContain("piece_captured");
    expect(getBlockades(result.state)).toEqual([{ color: null, cell: 46 }]);
  });

  it("una ficha que forma parte de una barrera puede salir de su casilla, rompiéndola", () => {
    const state = setup({ pink: [7, -1, -1, -1], green: [stepsForCell("green", 46), -1, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 4)).toEqual({ ok: true });
    expect(canMovePiece(state, "green", 0, 4)).toEqual({ ok: true });
    const after = run(act(state, roll("pink", 4)), move("pink", 0)).state;
    expect(getBlockades(after)).toEqual([]);
  });

  it("como máximo dos fichas por casilla, también en las normales", () => {
    // Casilla normal con dos fichas de colores distintos (estado construido): no cabe una tercera.
    const purple = stepsForCell("purple", 45);
    const green = stepsForCell("green", 45);
    expect(canMovePiece(setup({ pink: [4, -1, -1, -1], purple: [purple, -1, -1, -1], green: [green, -1, -1, -1] }), "pink", 0, 2)).toEqual({
      ok: false,
      error: "CELL_FULL",
    });
    // Caer junto a una ficha propia en una casilla normal sí: forma barrera.
    expect(canMovePiece(setup({ pink: [4, 6, -1, -1] }), "pink", 0, 2)).toEqual({ ok: true });
  });

  it("una barrera en la entrada del pasillo final impide entrar en él", () => {
    // pink en 32 (steps 61) con un 5 pasaría por 33 y 34 (entrada, segura) y entraría en el pasillo.
    const state = setup({ pink: [61, -1, -1, -1], green: [stepsForCell("green", 34), -1, -1, -1], blue: [stepsForCell("blue", 34), -1, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 5)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    // Sin la barrera, sí entra.
    expect(canMovePiece(setup({ pink: [61, -1, -1, -1], green: [stepsForCell("green", 34), -1, -1, -1] }), "pink", 0, 5)).toEqual({ ok: true });
    // Dentro del pasillo no hay barreras: se puede adelantar a dos fichas propias.
    expect(canMovePiece(setup({ pink: [68, 70, 70, -1] }), "pink", 0, 4)).toEqual({ ok: true });
  });

  it("los movimientos de bonus respetan las barreras: si la única ficha no puede usarlo, se pierde", () => {
    // pink (steps 10, casilla 49) captura a purple en 52 con un 3 y gana +20, que la llevaría por 56.
    const purple = stepsForCell("purple", 52);
    const base = { pink: [10, -1, -1, -1], purple: [purple, -1, -1, -1] };
    const blocked = run(act(setup({ ...base, blue: [0, -1, -1, -1], green: [stepsForCell("green", 56), -1, -1, -1] }), roll("pink", 3)), move("pink", 0));
    expect(eventTypes(blocked)).toContain("piece_captured");
    expect(eventTypes(blocked)).toContain("bonus_lost");
    // Sin la barrera de dos colores en 56, el bonus se puede usar.
    const free = run(act(setup({ ...base, blue: [0, -1, -1, -1] }), roll("pink", 3)), move("pink", 0));
    expect(eventTypes(free)).toContain("bonus_granted");
  });

  it("la salida de casa mantiene su regla: se sale capturando a la ficha rival de la propia salida", () => {
    // pink + green en la salida de pink (39, segura) forman barrera; con un 5 se sale y se captura a green.
    const state = act(setup({ pink: [0, -1, -1, -1], green: [stepsForCell("green", 39), -1, -1, -1] }), roll("pink", 5));
    const result = run(state, move("pink", 1));
    expect(eventTypes(result)).toContain("piece_captured");
    expect(steps(result.state, "green")[0]).toBe(-1);
    expect(getBlockades(result.state)).toEqual([{ color: "pink", cell: 39 }]);
  });
});

/** Número máximo de fichas en una misma casilla del recorrido. */
function maxPerCell(state: GameState): number {
  const perCell = new Map<number, number>();
  for (const p of state.players) {
    for (const piece of p.pieces) {
      if (piece.steps < 0 || piece.steps >= MAIN_TRACK_SIZE) continue;
      const cell = getRealBoardPosition(p.color, piece.steps);
      perCell.set(cell, (perCell.get(cell) ?? 0) + 1);
    }
  }
  return Math.max(0, ...perCell.values());
}

describe("salida de casa con 5 (regla definitiva)", () => {
  // Salida de pink: casilla 39 (segura).
  const greenAt39 = stepsForCell("green", 39);
  const blueAt39 = stepsForCell("blue", 39);
  const exitWith = (pieces: Parameters<typeof setup>[0], index: number) => run(act(setup(pieces), roll("pink", 5)), move("pink", index));

  it("casilla vacía: sale la ficha", () => {
    const result = exitWith({ pink: [-1, -1, -1, -1] }, 0);
    expect(steps(result.state, "pink")).toEqual([0, -1, -1, -1]);
    expect(eventTypes(result)).not.toContain("piece_captured");
  });

  it("una ficha propia: sale y quedan dos propias (barrera)", () => {
    const result = exitWith({ pink: [0, -1, -1, -1] }, 1);
    expect(steps(result.state, "pink")).toEqual([0, 0, -1, -1]);
    expect(getBlockades(result.state)).toEqual([{ color: "pink", cell: 39 }]);
    expect(maxPerCell(result.state)).toBe(2);
  });

  it("una ficha rival: sale y la captura", () => {
    const result = exitWith({ pink: [-1, -1, -1, -1], green: [greenAt39, -1, -1, -1] }, 0);
    expect(eventTypes(result)).toContain("piece_captured");
    expect(steps(result.state, "green")[0]).toBe(-1);
    expect(steps(result.state, "pink")[0]).toBe(0);
  });

  it("una propia y una rival (barrera de dos colores): sale y captura a la rival", () => {
    const result = exitWith({ pink: [0, -1, -1, -1], green: [greenAt39, -1, -1, -1] }, 1);
    expect(steps(result.state, "green")[0]).toBe(-1);
    expect(steps(result.state, "pink").slice(0, 2)).toEqual([0, 0]);
    expect(maxPerCell(result.state)).toBe(2);
  });

  it("dos fichas de otros colores (barrera de dos colores en un seguro): sale y captura a la que llegó la última", () => {
    // setup asigna arrivalOrder en el orden de los jugadores: green llega antes que blue.
    const state = setup({ green: [greenAt39, -1, -1, -1], blue: [blueAt39, -1, -1, -1] });
    expect(getBlockades(state)).toEqual([{ color: null, cell: 39 }]);
    // La barrera bloquea el movimiento normal por la casilla 39...
    const passing = setup({ purple: [stepsForCell("purple", 37), -1, -1, -1], green: [greenAt39, -1, -1, -1], blue: [blueAt39, -1, -1, -1] });
    expect(canMovePiece(passing, "purple", 0, 4)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    // ...pero no la salida de casa, que tiene su regla de captura.
    const result = run(act(state, roll("pink", 5)), move("pink", 0));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "piece_captured", victimId: "blue", cell: 39 }));
    expect(steps(result.state, "blue")[0]).toBe(-1);
    expect(steps(result.state, "green")[0]).toBe(greenAt39);
    expect(maxPerCell(result.state)).toBe(2);
  });

  it("dos fichas de colores distintos: captura según arrivalOrder, no según el orden de los jugadores", () => {
    // Por orden de jugadores green va antes que blue; aquí green llegó la última y es la capturada.
    const state = setup({ green: [greenAt39, -1, -1, -1], blue: [blueAt39, -1, -1, -1] });
    state.players.find((p) => p.color === "green")!.pieces[0].arrivalOrder = 99;
    const result = run(act(state, roll("pink", 5)), move("pink", 0));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "piece_captured", victimId: "green", cell: 39 }));
    expect(steps(result.state, "green")[0]).toBe(-1);
    expect(steps(result.state, "blue")[0]).toBe(blueAt39);
    expect(maxPerCell(result.state)).toBe(2);
  });

  it("getLegalMoves aplica la obligación de salir con 5 directamente (antes de cualquier otro filtro)", () => {
    // pink en 10 podría avanzar 5, pero hay fichas en casa que pueden salir.
    const state = setup({ pink: [10, 20, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 5)).toEqual({ ok: true });
    expect(getLegalMoves(state, "pink", 5)).toEqual([2, 3]);
    // Con un 6 o un 4 no hay obligación de salir (ni podrían salir).
    expect(getLegalMoves(state, "pink", 4)).toEqual([0, 1]);
    expect(getLegalMoves(state, "pink", 6)).toEqual([0, 1]);
    // Y con la salida bloqueada por dos propias, el 5 se juega normal.
    expect(getLegalMoves(setup({ pink: [0, 0, 10, -1] }), "pink", 5)).toEqual([0, 1, 2]);
  });

  it("dos fichas del mismo color rival: captura a la que llegó la última (según arrivalOrder)", () => {
    const state = setup({ blue: [blueAt39, blueAt39, -1, -1] });
    state.players.find((p) => p.color === "blue")!.pieces[0].arrivalOrder = 99; // la 0 llegó la última
    const result = run(act(state, roll("pink", 5)), move("pink", 0));
    expect(steps(result.state, "blue").slice(0, 2)).toEqual([-1, blueAt39]);
  });

  it("dos fichas propias en la salida: no puede salir y se juega el 5 con normalidad", () => {
    const state = setup({ pink: [0, 0, -1, -1] });
    expect(canMovePiece(state, "pink", 2, 5)).toEqual({ ok: false, error: "OWN_BLOCKADE_ON_EXIT" });
    expect(getAvailableMoves(act(state, roll("pink", 5)))).toEqual([0, 1]);
  });

  it("con un 5 y fichas en casa es obligatorio sacar una; si no puede salir ninguna, se juega normal", () => {
    const state = act(setup({ pink: [10, -1, -1, -1] }), roll("pink", 5));
    expect(getAvailableMoves(state)).toEqual([1, 2, 3]);
    expect(canMovePiece(state, "pink", 0, 5)).toEqual({ ok: true }); // el movimiento sería válido por sí mismo...
    expect(applyAction(state, move("pink", 0))).toEqual({ ok: false, error: "MUST_EXIT_HOME" }); // ...pero hay que salir
    // Sin fichas en casa, el 5 se juega normal.
    expect(getAvailableMoves(act(setup({ pink: [10, 20, 72, 72] }), roll("pink", 5)))).toEqual([0, 1]);
  });

  it("nunca se superan dos fichas en la salida", () => {
    for (const pieces of [
      { pink: [0, -1, -1, -1], green: [greenAt39, -1, -1, -1] },
      { green: [greenAt39, -1, -1, -1], blue: [blueAt39, -1, -1, -1] },
      { blue: [blueAt39, blueAt39, -1, -1] },
      { pink: [0, -1, -1, -1] },
    ] as Parameters<typeof setup>[0][]) {
      const result = run(act(setup(pieces), roll("pink", 5)), move("pink", getAvailableMoves(act(setup(pieces), roll("pink", 5)))[0]));
      expect(maxPerCell(result.state)).toBeLessThanOrEqual(2);
    }
  });
});

describe("obligación de abrir barreras con un 6 (regla definitiva)", () => {
  it("barrera propia en casilla normal: solo se pueden mover sus fichas", () => {
    const state = act(setup({ pink: [3, 3, 20, -1] }), roll("pink", 6)); // barrera en 42 (normal)
    expect(getAvailableMoves(state)).toEqual([0, 1]);
    expect(applyAction(state, move("pink", 2))).toEqual({ ok: false, error: "MUST_BREAK_BLOCKADE" });
    const result = run(state, move("pink", 0));
    expect(getBlockades(result.state)).toEqual([]);
  });

  it("barrera de dos colores en un seguro en la que participa: hay que abrirla", () => {
    // pink en 46 (segura) junto a blue; otra ficha pink en 59.
    const state = act(setup({ pink: [7, 20, -1, -1], blue: [stepsForCell("blue", 46), -1, -1, -1] }), roll("pink", 6));
    expect(getAvailableMoves(state)).toEqual([0]);
    expect(applyAction(state, move("pink", 1))).toEqual({ ok: false, error: "MUST_BREAK_BLOCKADE" });
    const result = run(state, move("pink", 0));
    expect(getBlockades(result.state)).toEqual([]);
  });

  it("getLegalMoves con 6 incluye barreras propias y de dos colores a la vez, y applyAction rechaza el resto", () => {
    // Barrera propia en 59 (normal), barrera pink + blue en 46 (segura) y otra ficha pink en 1.
    // Las tres fichas de barrera pueden avanzar 6 sin cruzar ninguna barrera.
    const state = act(setup({ pink: [20, 20, 7, 30], blue: [stepsForCell("blue", 46), -1, -1, -1] }), roll("pink", 6));
    expect(canMovePiece(state, "pink", 3, 6)).toEqual({ ok: true }); // válida por sí misma, pero no abre ninguna
    expect(getLegalMoves(state, "pink", 6)).toEqual([0, 1, 2]);
    expect(getAvailableMoves(state)).toEqual([0, 1, 2]);
    expect(applyAction(state, move("pink", 3))).toEqual({ ok: false, error: "MUST_BREAK_BLOCKADE" });
    // Solo la de dos colores (la ficha pink de 46 es la única que participa en una barrera).
    const mixed = setup({ pink: [7, 20, 30, -1], blue: [stepsForCell("blue", 46), -1, -1, -1] });
    expect(getLegalMoves(mixed, "pink", 6)).toEqual([0]);
  });

  it("sin apertura legal, el 6 se juega con normalidad y applyAction acepta un movimiento normal", () => {
    // Barrera pink + blue en 46; una barrera green en 50 impide abrirla con un 6 (46 → 52 pasa por 50).
    const g = stepsForCell("green", 50);
    const state = act(setup({ pink: [7, 20, -1, -1], blue: [stepsForCell("blue", 46), -1, -1, -1], green: [g, g, -1, -1] }), roll("pink", 6));
    expect(canMovePiece(state, "pink", 0, 6)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
    expect(getAvailableMoves(state)).toEqual([1]);
    expect(steps(run(state, move("pink", 1)).state, "pink")[1]).toBe(26);
  });

  it("no exige abrir barreras formadas solo por fichas rivales", () => {
    const b = stepsForCell("blue", 50);
    const mixed = { purple: [stepsForCell("purple", 46), -1, -1, -1], green: [stepsForCell("green", 46), -1, -1, -1] };
    const state = act(setup({ pink: [20, 30, -1, -1], blue: [b, b, -1, -1], ...mixed }), roll("pink", 6));
    expect(getAvailableMoves(state)).toEqual([0, 1]);
  });

  it("las demás fichas no se pueden mover si existe alguna apertura legal, aunque otra barrera propia no se pueda abrir", () => {
    // Barreras propias en 44 (bloqueada por blue en 50) y en 59 (se puede abrir).
    const b = stepsForCell("blue", 50);
    const state = act(setup({ pink: [5, 5, 20, 20], blue: [b, b, -1, -1] }), roll("pink", 6));
    expect(getAvailableMoves(state)).toEqual([2, 3]);
  });

  it("los bonus (+10/+20) no son un 6: no obligan a abrir barreras", () => {
    // Barrera pink en 44; la ficha 2 (casilla 49) captura a purple en 52 con un 3 y gana +20.
    const purple = stepsForCell("purple", 52);
    const result = run(act(setup({ pink: [5, 5, 10, -1], purple: [purple, -1, -1, -1] }), roll("pink", 3)), move("pink", 2));
    expect(result.state.pendingBonus).toMatchObject({ amount: 20 });
    expect(getAvailableMoves(result.state)).toEqual([0, 1, 2]);
  });
});

describe("capturas y casillas seguras", () => {
  it("caer sobre una ficha rival en casilla normal la captura y da 20", () => {
    // pink steps 13 => casilla 52 (no segura).
    const purple = stepsForCell("purple", 52);
    const state = act(setup({ pink: [10, -1, -1, -1], purple: [purple, -1, -1, -1] }), roll("pink", 3));
    const result = run(state, move("pink", 0));
    expect(result.events).toContainEqual({
      type: "piece_captured",
      playerId: "pink",
      victimId: "purple",
      victimPieceIndex: 0,
      cell: 52,
    });
    expect(steps(result.state, "purple")[0]).toBe(-1);
    expect(result.state.pendingBonus).toMatchObject({ amount: 20, reason: "capture" });
  });

  it("en una casilla segura no se captura", () => {
    // pink steps 24 => casilla 63 (segura).
    const purple = stepsForCell("purple", 63);
    const state = act(setup({ pink: [21, -1, -1, -1], purple: [purple, -1, -1, -1] }), roll("pink", 3));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).not.toContain("piece_captured");
    expect(steps(result.state, "purple")[0]).toBe(purple);
  });

  it("una casilla segura admite como máximo dos fichas (dos fichas de distinto color ya son barrera)", () => {
    const purple = stepsForCell("purple", 63);
    const green = stepsForCell("green", 63);
    const state = setup({ pink: [21, -1, -1, -1], purple: [purple, -1, -1, -1], green: [green, -1, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 3)).toEqual({ ok: false, error: "BLOCKADE_IN_PATH" });
  });
});

describe("pasillo final y meta", () => {
  it("al pasar la entrada se entra en el pasillo final", () => {
    // steps 60: faltan 3 para la entrada; con un 5 => 68 + (5 - 3 - 1) = 69.
    const state = act(setup({ pink: [60, 72, 72, 72] }), roll("pink", 5)); // sin fichas en casa: no hay salida obligatoria
    const result = run(state, move("pink", 0));
    expect(result.state.players[0].pieces[0]).toMatchObject({ state: "final", steps: 69 });
  });

  it("para llegar a la meta hace falta la tirada exacta", () => {
    const state = setup({ pink: [72, -1, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 5)).toEqual({ ok: false, error: "EXACT_ROLL_REQUIRED" });
    expect(canMovePiece(state, "pink", 0, 3)).toEqual({ ok: true });
    // Tampoco al entrar desde el recorrido: desde la entrada (63) hacen falta 8.
    expect(canMovePiece(setup({ pink: [62, -1, -1, -1] }), "pink", 0, 10)).toEqual({ ok: false, error: "EXACT_ROLL_REQUIRED" });
  });

  it("llegar a la meta da un bonus de 10", () => {
    const state = act(setup({ pink: [70, 10, 72, 72] }), roll("pink", 5)); // sin fichas en casa
    const result = run(state, move("pink", 0));
    expect(result.state.players[0].pieces[0]).toMatchObject({ state: "finished", steps: 75 });
    expect(eventTypes(result)).toEqual(["piece_moved", "piece_reached_goal", "bonus_granted"]);
    expect(result.state.pendingBonus).toMatchObject({ amount: 10, reason: "goal", fromSix: false });
  });

  it("si ninguna ficha puede usar el bonus, se pierde y pasa el turno", () => {
    // Sin fichas en casa (no hay salida obligatoria); las del pasillo no pueden usar +10.
    const state = act(setup({ pink: [70, 72, 72, 72] }), roll("pink", 5));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).toEqual(["piece_moved", "piece_reached_goal", "bonus_lost", "turn_changed"]);
    expect(result.state.pendingBonus).toBeNull();
  });
});

describe("bonificaciones", () => {
  const purple55 = stepsForCell("purple", 55);

  it("el bonus se usa antes de tirar y luego pasa el turno", () => {
    const purple = stepsForCell("purple", 52);
    let state = act(setup({ pink: [10, -1, -1, -1], purple: [purple, -1, -1, -1] }), roll("pink", 3));
    state = act(state, move("pink", 0));
    expect(applyAction(state, roll("pink", 4))).toEqual({ ok: false, error: "BONUS_PENDING" });
    const result = run(state, move("pink", 0));
    expect(steps(result.state, "pink")[0]).toBe(33);
    expect(result.events[0]).toMatchObject({ type: "piece_moved", distance: 20, withBonus: true });
    expect(result.state.turn).toBe("blue");
  });

  it("si el bonus vino de un movimiento con 6, después se vuelve a tirar", () => {
    let state = act(setup({ pink: [10, -1, -1, -1], purple: [purple55, -1, -1, -1] }), roll("pink", 6));
    state = act(state, move("pink", 0));
    expect(state.pendingBonus).toMatchObject({ amount: 20, fromSix: true });
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).toContain("roll_again");
    expect(result.state.turn).toBe("pink");
  });

  it("una captura durante un movimiento de bonus da otro bonus (corrección)", () => {
    // Tras capturar en la casilla 55 (steps 16), +20 => steps 36 => casilla 7 (no segura).
    const green = stepsForCell("green", 7);
    let state = act(
      setup({ pink: [10, -1, -1, -1], purple: [purple55, -1, -1, -1], green: [green, -1, -1, -1] }),
      roll("pink", 6),
    );
    state = act(state, move("pink", 0));
    const result = run(state, move("pink", 0));
    expect(eventTypes(result)).toEqual(["piece_moved", "piece_captured", "bonus_granted"]);
    expect(result.state.pendingBonus).toMatchObject({ amount: 20, fromSix: true });
  });
});

describe("turnos", () => {
  it("orden pink -> blue -> purple -> green con cuatro jugadores", () => {
    let state = createGame([..."abcd"]); // a=pink b=purple c=green d=blue
    const order: string[] = [state.turn];
    for (let i = 0; i < 4; i++) {
      state = act(state, roll(state.turn, 1));
      order.push(state.turn);
    }
    expect(order).toEqual(["a", "d", "b", "c", "a"]);
  });

  it("salta los colores que no juegan", () => {
    let state = createGame(["a", "b"]); // pink, purple
    state = act(state, roll("a", 1));
    expect(state.turn).toBe("b");
    state = act(state, roll("b", 1));
    expect(state.turn).toBe("a");
  });

  it("timeout: pierde el bonus pendiente y pasa el turno", () => {
    const purple = stepsForCell("purple", 52);
    let state = act(setup({ pink: [10, -1, -1, -1], purple: [purple, -1, -1, -1] }), roll("pink", 3));
    state = act(state, move("pink", 0));
    const result = run(state, { type: "timeout" });
    expect(eventTypes(result)).toEqual(["turn_timeout", "turn_changed"]);
    expect(result.state.pendingBonus).toBeNull();
    expect(result.state.turn).toBe("blue");
  });

  it("cuando un jugador termina y la partida sigue, el siguiente puede tirar (corrección)", () => {
    const state = act(setup({ pink: [75, 75, 75, 70] }, ["pink", "purple", "green"]), roll("pink", 5));
    const result = run(state, move("pink", 3));
    expect(eventTypes(result)).toEqual([
      "piece_moved",
      "piece_reached_goal",
      "player_finished",
      "turn_changed",
    ]);
    expect(result.state.dice).toBeNull();
    expect(result.state.turn).toBe("purple");
    expect(result.state.status).toBe("playing");
    // purple puede tirar y después se salta a pink (ya ha terminado).
    let next = act(result.state, roll("purple", 1));
    next = act(next, roll("green", 1));
    expect(next.turn).toBe("purple");
  });

  it("quien termina con un bonus que venía de un 6 no vuelve a tirar (corrección)", () => {
    // C (steps 69) llega a la meta con un 6; D (steps 61) usa el bonus de 10 y termina.
    let state = act(setup({ pink: [75, 75, 69, 61] }, ["pink", "purple", "green"]), roll("pink", 6));
    state = act(state, move("pink", 2));
    expect(state.pendingBonus).toMatchObject({ amount: 10, fromSix: true });
    const result = run(state, move("pink", 3));
    expect(eventTypes(result)).toContain("player_finished");
    expect(eventTypes(result)).not.toContain("roll_again");
    expect(result.state.turn).toBe("purple");
  });

  it("la partida termina cuando solo queda un jugador sin acabar", () => {
    const state = act(setup({ pink: [75, 75, 75, 70] }, ["pink", "purple"]), roll("pink", 5));
    const result = run(state, move("pink", 3));
    expect(result.state.status).toBe("finished");
    expect(result.state.winner).toBe("pink");
    expect(result.state.ranking).toEqual(["pink", "purple"]);
    expect(result.events.at(-1)).toEqual({
      type: "game_finished",
      winner: "pink",
      ranking: ["pink", "purple"],
    });
    expect(applyAction(result.state, roll("purple", 3))).toEqual({ ok: false, error: "GAME_FINISHED" });
  });
});

describe("penalización por tres seises", () => {
  it("al tercer seis la última ficha movida vuelve a casa y pasa el turno", () => {
    let state = setup({ pink: [0, 20, -1, -1] });
    state = act(act(state, roll("pink", 6)), move("pink", 0));
    state = act(act(state, roll("pink", 6)), move("pink", 1));
    expect(steps(state, "pink")).toEqual([6, 26, -1, -1]);
    const result = run(state, roll("pink", 6));
    expect(eventTypes(result)).toEqual(["dice_rolled", "third_six_penalty", "turn_changed"]);
    expect(result.events[1]).toEqual({ type: "third_six_penalty", playerId: "pink", pieceIndex: 1 });
    expect(steps(result.state, "pink")).toEqual([6, -1, -1, -1]);
    expect(result.state.turn).toBe("blue");
    expect(result.state.sixesInTurn).toBe(0);
  });

  it("tres seises sin movimientos también pasan el turno (corrección)", () => {
    let state = createGame([..."abcd"]);
    state = act(state, roll("a", 6));
    state = act(state, roll("a", 6));
    const result = run(state, roll("a", 6));
    expect(result.events[1]).toEqual({ type: "third_six_penalty", playerId: "a", pieceIndex: null });
    expect(result.state.turn).toBe("d");
  });

  it("solo se penaliza una ficha del propio jugador", () => {
    let state = setup({ blue: [10, -1, -1, -1] });
    state = act(state, roll("pink", 1)); // pasa a blue
    state = act(act(state, roll("blue", 2)), move("blue", 0)); // última ficha movida: blue
    state = act(state, roll("purple", 1));
    state = act(state, roll("green", 1));
    state = act(state, roll("pink", 6));
    state = act(state, roll("pink", 6));
    const result = run(state, roll("pink", 6));
    expect(result.events[1]).toMatchObject({ pieceIndex: null });
    expect(steps(result.state, "blue")[0]).toBe(12);
  });

  it("el contador de seises se reinicia al cambiar de turno", () => {
    let state = createGame(["a", "b"]);
    state = act(state, roll("a", 6));
    state = act(state, roll("a", 6));
    state = act(state, { type: "timeout" });
    expect(state.sixesInTurn).toBe(0);
  });
});

describe("tramo final: entrada + 7 casillas de color + meta", () => {
  const COLORS_ = ["pink", "purple", "green", "blue"] as const;
  const EXPECTED_ENTRY = { pink: 34, purple: 0, green: 17, blue: 51 } as const; // 0 = casilla impresa "68"

  /** Pasa turnos (los demás jugadores tiran 1 sin poder mover) hasta que le toque a `color`. */
  function untilTurn(state: GameState, color: string): GameState {
    while (state.turn !== color) state = act(state, roll(state.turn, 1));
    return state;
  }

  it("el tramo final tiene 8 casillas (entrada + 7 de color) y la meta va aparte", () => {
    expect(FINAL_SECTION_SIZE).toBe(8);
    expect(FINAL_STRETCH_SIZE).toBe(7);
    expect(FINAL_POSITION).toBe(HOME_ENTRY_STEPS + 12); // 63 -> 68..74 son 7 casillas y la 8ª es 75
    expect(FINAL_POSITION - MAIN_TRACK_SIZE).toBe(FINAL_STRETCH_SIZE);
  });

  for (const color of COLORS_) {
    describe(color, () => {
      it(`la entrada es la casilla ${EXPECTED_ENTRY[color] || 68} y es la 1ª del tramo final`, () => {
        expect(HOME_ENTRIES[color]).toBe(EXPECTED_ENTRY[color]);
        expect(getRealBoardPosition(color, HOME_ENTRY_STEPS)).toBe(EXPECTED_ENTRY[color]);
        expect(getDistanceToHomeEntry(color, HOME_ENTRY_STEPS)).toBe(0);
        // La casilla anterior está a 1 de la entrada.
        expect(getDistanceToHomeEntry(color, HOME_ENTRY_STEPS - 1)).toBe(1);
      });

      it("desde la entrada se recorren las 7 casillas de color y la 8ª es la meta, sin saltar ni repetir", () => {
        let state = setup({ [color]: [HOME_ENTRY_STEPS - 1, -1, -1, -1] });
        // Casilla anterior -> entrada (sigue en el recorrido común).
        state = untilTurn(state, color);
        state = act(act(state, roll(color, 1)), move(color, 0));
        expect(state.players.find((p) => p.color === color)!.pieces[0]).toMatchObject({
          state: "track",
          steps: HOME_ENTRY_STEPS,
        });

        const visited: number[] = [];
        for (let i = 1; i <= 7; i++) {
          state = untilTurn(state, color);
          state = act(act(state, roll(color, 1)), move(color, 0));
          const piece = state.players.find((p) => p.color === color)!.pieces[0];
          expect(piece.state).toBe("final");
          visited.push(piece.steps);
        }
        expect(visited).toEqual([68, 69, 70, 71, 72, 73, 74]);

        state = untilTurn(state, color);
        const result = run(act(state, roll(color, 1)), move(color, 0));
        expect(result.state.players.find((p) => p.color === color)!.pieces[0]).toMatchObject({
          state: "finished",
          steps: FINAL_POSITION,
        });
        expect(eventTypes(result)).toContain("piece_reached_goal");
      });

      it("desde la entrada: 1..8 casillas son válidas, 8 llega exacta a la meta y 9 o más no", () => {
        const state = setup({ [color]: [HOME_ENTRY_STEPS, -1, -1, -1] });
        for (let d = 1; d <= 8; d++) expect(canMovePiece(state, color, 0, d)).toEqual({ ok: true });
        for (const d of [9, 10, 20]) {
          expect(canMovePiece(state, color, 0, d)).toEqual({ ok: false, error: "EXACT_ROLL_REQUIRED" });
        }
      });
    });
  }

  it("con dados reales: entrada + 6 -> 6ª casilla de color; un 3 no vale, un 2 llega a la meta", () => {
    let state = act(setup({ pink: [HOME_ENTRY_STEPS, -1, -1, -1] }), roll("pink", 6));
    state = act(state, move("pink", 0)); // con 6 repite
    expect(steps(state, "pink")[0]).toBe(73);
    expect(canMovePiece(state, "pink", 0, 3)).toEqual({ ok: false, error: "EXACT_ROLL_REQUIRED" });
    const noMove = run(state, roll("pink", 3));
    expect(eventTypes(noMove)).toEqual(["dice_rolled", "no_moves", "turn_changed"]);
    state = untilTurn(noMove.state, "pink");
    const result = run(act(state, roll("pink", 2)), move("pink", 0));
    expect(steps(result.state, "pink")[0]).toBe(FINAL_POSITION);
  });

  it("al entrar desde el recorrido, la entrada cuenta como una casilla (no se cuenta dos veces)", () => {
    // A 3 casillas de la entrada: 3 llega a la entrada, 4 a la 1ª de color, 11 a la meta.
    const state = setup({ green: [HOME_ENTRY_STEPS - 3, -1, -1, -1] });
    const target = (d: number) => {
      const r = act(act(untilTurn(state, "green"), { type: "roll", playerId: "green", value: Math.min(d, 6) }), move("green", 0));
      return steps(r, "green")[0];
    };
    expect(target(3)).toBe(HOME_ENTRY_STEPS);
    expect(target(4)).toBe(68);
    expect(target(6)).toBe(70);
    expect(canMovePiece(state, "green", 0, 11)).toEqual({ ok: true }); // 3 + 8
    expect(canMovePiece(state, "green", 0, 12)).toEqual({ ok: false, error: "EXACT_ROLL_REQUIRED" });
  });

  it("la entrada sigue siendo casilla del recorrido común: otros colores pasan por ella", () => {
    // purple en la casilla 33 avanza 2: pasa por 34 (entrada de pink) y llega a 35.
    const state = act(setup({ purple: [stepsForCell("purple", 33), -1, -1, -1] }, ["pink", "purple"]), roll("pink", 1));
    const result = run(act(state, roll("purple", 2)), move("purple", 0));
    expect(getRealBoardPosition("purple", steps(result.state, "purple")[0])).toBe(35);
  });
});
