import { describe, expect, it } from "vitest";
import { getDistanceToHomeEntry, getRealBoardPosition } from "../board";
import {
  FINAL_POSITION,
  FINAL_SECTION_SIZE,
  FINAL_STRETCH_SIZE,
  HOME_ENTRIES,
  HOME_ENTRY_STEPS,
  MAIN_TRACK_SIZE,
} from "../constants";
import { applyAction, createGame, getAvailableMoves } from "../engine";
import { canMovePiece } from "../moves";
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

  it("si la barrera no se puede abrir, no hay movimientos (comportamiento original, interpretación dudosa)", () => {
    // La barrera pink está en la casilla 44; una barrera blue en la 50 impide abrirla con un 6.
    const b = stepsForCell("blue", 50);
    const state = setup({ pink: [5, 5, 20, -1], blue: [b, b, -1, -1] });
    expect(canMovePiece(state, "pink", 2, 6).ok).toBe(true);
    const result = run(state, roll("pink", 6));
    expect(eventTypes(result)).toContain("no_moves");
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

  it("una casilla segura admite como máximo dos fichas", () => {
    const purple = stepsForCell("purple", 63);
    const green = stepsForCell("green", 63);
    const state = setup({ pink: [21, -1, -1, -1], purple: [purple, -1, -1, -1], green: [green, -1, -1, -1] });
    expect(canMovePiece(state, "pink", 0, 3)).toEqual({ ok: false, error: "SAFE_CELL_FULL" });
  });
});

describe("pasillo final y meta", () => {
  it("al pasar la entrada se entra en el pasillo final", () => {
    // steps 60: faltan 3 para la entrada; con un 5 => 68 + (5 - 3 - 1) = 69.
    const state = act(setup({ pink: [60, -1, -1, -1] }), roll("pink", 5));
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
    const state = act(setup({ pink: [70, 10, -1, -1] }), roll("pink", 5));
    const result = run(state, move("pink", 0));
    expect(result.state.players[0].pieces[0]).toMatchObject({ state: "finished", steps: 75 });
    expect(eventTypes(result)).toEqual(["piece_moved", "piece_reached_goal", "bonus_granted"]);
    expect(result.state.pendingBonus).toMatchObject({ amount: 10, reason: "goal", fromSix: false });
  });

  it("si ninguna ficha puede usar el bonus, se pierde y pasa el turno", () => {
    const state = act(setup({ pink: [70, -1, -1, -1] }), roll("pink", 5));
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
