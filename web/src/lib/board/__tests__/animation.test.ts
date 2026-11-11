import { describe, expect, it } from "vitest";
import {
  FINAL_POSITION,
  HOME_ENTRY_STEPS,
  applyAction,
  createGame,
  getAvailableMoves,
  type ActionResult,
  type GameAction,
  type GameState,
} from "@/lib/engine";
import {
  ANIMATION_TIMING,
  animationDuration,
  applyPositions,
  buildAnimation,
  pieceKey,
  positionsOf,
  type AnimationFrame,
} from "../animation";
import { CELL_LENGTH, HOME_STRETCH, TRACK_CELLS } from "../geometry";
import { JOURNEY_LENGTH, journeySteps, journeyToSteps, pieceStateForSteps, stepsToJourney } from "../journey";
import { getPieceSlot, layoutPieces } from "../layout";

const IDS = ["rosa", "morado", "verde", "azul"]; // pink, purple, green, blue

function place(state: GameState, playerIndex: number, steps: number[]): GameState {
  const next = structuredClone(state);
  next.players[playerIndex].pieces = steps.map((s, i) => ({ steps: s, state: pieceStateForSteps(s), arrivalOrder: i + 1 }));
  next.moveCounter = 10;
  return next;
}

function run(state: GameState, action: GameAction) {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(result.error);
  return result as Extract<ActionResult, { ok: true }>;
}

/** Tira y mueve; devuelve los fotogramas del movimiento. */
function rollAndMove(state: GameState, playerId: string, value: number, pieceIndex: number) {
  const rolled = run(state, { type: "roll", playerId, value }).state;
  const moved = run(rolled, { type: "move", playerId, pieceIndex });
  return { frames: buildAnimation(rolled, moved.events, moved.state), result: moved, before: rolled };
}

const stepsOfMoving = (frames: AnimationFrame[], playerId: string, pieceIndex: number) =>
  frames.filter((f) => f.movingKey === pieceKey(playerId, pieceIndex)).map((f) => f.positions[playerId][pieceIndex]);

/** Centro dibujado de la casilla de una ficha según sus `steps`. */
function center(color: "pink" | "purple" | "green" | "blue", steps: number) {
  const slot = getPieceSlot(color, 0, steps);
  if (slot.kind === "track") return TRACK_CELLS[slot.cell];
  if (slot.kind === "stretch") return HOME_STRETCH[slot.color][slot.index];
  return null;
}

describe("recorrido continuo (journey)", () => {
  it("63 casillas de recorrido + 8 de tramo final; ida y vuelta sin pérdidas", () => {
    expect(JOURNEY_LENGTH).toBe(71);
    for (let j = 0; j <= JOURNEY_LENGTH; j++) expect(stepsToJourney(journeyToSteps(j))).toBe(j);
    expect(journeyToSteps(63)).toBe(HOME_ENTRY_STEPS);
    expect(journeyToSteps(64)).toBe(68);
    expect(journeyToSteps(71)).toBe(FINAL_POSITION);
  });

  it("pasos de cada movimiento: salida, recorrido, entrada al pasillo y meta", () => {
    expect(journeySteps(-1, 0)).toEqual([0]);
    expect(journeySteps(10, 13)).toEqual([11, 12, 13]);
    expect(journeySteps(61, 69)).toEqual([62, 63, 68, 69]); // sin 64..67, que no existen
    expect(journeySteps(70, 75)).toEqual([71, 72, 73, 74, 75]);
  });
});

describe("fotogramas de la animación", () => {
  it("una tirada sin movimiento no genera animación", () => {
    const state = createGame(IDS);
    const result = run(state, { type: "roll", playerId: "rosa", value: 3 });
    expect(buildAnimation(state, result.events, result.state)).toEqual([]);
  });

  it("salida de casa: un salto a la casilla de salida y el fotograma final", () => {
    const { frames, result } = rollAndMove(createGame(IDS), "rosa", 5, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ movingKey: "rosa:2", durationMs: ANIMATION_TIMING.exitMs });
    expect(frames[0].positions.rosa[2]).toBe(0);
    expect(frames[1]).toEqual({ positions: positionsOf(result.state), movingKey: null, durationMs: ANIMATION_TIMING.settleMs });
  });

  it("movimiento normal: una casilla por fotograma, en orden", () => {
    const state = place(createGame(IDS), 0, [10, -1, -1, -1]);
    const { frames } = rollAndMove(state, "rosa", 4, 0);
    expect(stepsOfMoving(frames, "rosa", 0)).toEqual([11, 12, 13, 14]);
    expect(frames.slice(0, 4).every((f) => f.durationMs === ANIMATION_TIMING.hopMs)).toBe(true);
  });

  it("cada salto va a una casilla contigua del tablero, también en las esquinas y al entrar al pasillo", () => {
    // pink desde steps 50 (casilla 21): 6 + 6 + 4 (sin tercer seis) + 3 = 19 casillas,
    // pasando por la esquina de las casillas 25→26, la entrada (34) y el pasillo (68..73).
    let state = place(createGame(["rosa", "morado"]), 0, [50, -1, -1, -1]);
    const visited: number[] = [];
    for (const value of [6, 6, 4, 3]) {
      const { frames, result } = rollAndMove(state, "rosa", value, 0);
      visited.push(...stepsOfMoving(frames, "rosa", 0));
      state = result.state;
      while (state.turn !== "rosa") state = run(state, { type: "roll", playerId: state.turn, value: 1 }).state;
    }
    expect(visited).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 68, 69, 70, 71, 72, 73]);
    const points = [50, ...visited].map((s) => center("pink", s)!);
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      expect(d, `salto ${i}`).toBeGreaterThan(0);
      expect(d, `salto ${i}`).toBeLessThanOrEqual(CELL_LENGTH * 1.3); // esquinas: diagonal ≈ 1,2 casillas
    }
  });

  it("llegada a la meta: el último salto acaba en la meta", () => {
    const state = place(createGame(IDS), 0, [72, 10, -1, -1]);
    const { frames, result } = rollAndMove(state, "rosa", 3, 0);
    expect(stepsOfMoving(frames, "rosa", 0)).toEqual([73, 74, 75]);
    expect(getPieceSlot("pink", 0, 75)).toEqual({ kind: "goal", color: "pink", pieceIndex: 0 });
    expect(frames.at(-1)!.positions).toEqual(positionsOf(result.state));
  });

  it("captura: la ficha capturada vuelve a casa después de que llegue la que captura", () => {
    // rosa en steps 10 + 3 => casilla 52; morado en steps 47 (casilla 52).
    const state = place(place(createGame(IDS), 0, [10, -1, -1, -1]), 1, [47, -1, -1, -1]);
    const { frames } = rollAndMove(state, "rosa", 3, 0);
    expect(frames.map((f) => f.movingKey)).toEqual(["rosa:0", "rosa:0", "rosa:0", "morado:0", null]);
    const capture = frames[3];
    expect(capture.durationMs).toBe(ANIMATION_TIMING.toBaseMs);
    expect(capture.positions.morado[0]).toBe(-1);
    expect(capture.positions.rosa[0]).toBe(13);
    // Mientras la ficha que captura avanza, la capturada sigue en su casilla.
    expect(frames[2].positions.morado[0]).toBe(47);
  });

  it("captura al salir de casa: salto a la salida y la rival a su casa", () => {
    const state = place(createGame(IDS), 3, [51, -1, -1, -1]); // azul en la casilla 39 (salida de pink)
    const { frames } = rollAndMove(state, "rosa", 5, 0);
    expect(frames.map((f) => f.movingKey)).toEqual(["rosa:0", "azul:0", null]);
  });

  it("bonus de 20: 20 saltos con la duración total acotada", () => {
    let state = place(place(createGame(IDS), 0, [10, -1, -1, -1]), 1, [47, -1, -1, -1]);
    state = rollAndMove(state, "rosa", 3, 0).result.state; // captura -> bonus de 20
    expect(state.pendingBonus?.amount).toBe(20);
    const moved = run(state, { type: "move", playerId: "rosa", pieceIndex: 0 });
    const frames = buildAnimation(state, moved.events, moved.state);
    const hops = frames.filter((f) => f.movingKey === "rosa:0");
    expect(hops).toHaveLength(20);
    expect(animationDuration(hops)).toBeLessThanOrEqual(ANIMATION_TIMING.maxMoveMs);
    expect(hops.every((f) => f.durationMs >= ANIMATION_TIMING.minHopMs)).toBe(true);
  });

  it("tercer seis: la ficha penalizada vuelve a casa", () => {
    let state = place(createGame(IDS), 0, [0, 20, -1, -1]);
    state = rollAndMove(state, "rosa", 6, 0).result.state;
    state = rollAndMove(state, "rosa", 6, 1).result.state;
    const result = run(state, { type: "roll", playerId: "rosa", value: 6 });
    const frames = buildAnimation(state, result.events, result.state);
    expect(frames.map((f) => f.movingKey)).toEqual(["rosa:1", null]);
    expect(frames[0].positions.rosa[1]).toBe(-1);
  });

  it("applyPositions solo cambia las fichas y su estado, no el resto del estado real", () => {
    const state = place(createGame(IDS), 0, [10, -1, -1, -1]);
    const shown = applyPositions(state, { ...positionsOf(state), rosa: [69, -1, -1, 75] });
    expect(shown.players[0].pieces.map((p) => [p.steps, p.state])).toEqual([[69, "final"], [-1, "base"], [-1, "base"], [75, "finished"]]);
    expect(shown.turn).toBe(state.turn);
    expect(state.players[0].pieces[0].steps).toBe(10); // el original no cambia
  });
});

describe("ficha en movimiento en el tablero", () => {
  it("no se apila con las que encuentra: va centrada y las demás no se recolocan", () => {
    // rosa:0 y rosa:1 en la misma casilla; rosa:1 está pasando por ella.
    const state = place(createGame(IDS), 0, [10, 10, -1, -1]);
    const still = layoutPieces(state, { movingKey: "rosa:1" });
    const moving = still.find((p) => p.key === "rosa:1")!;
    const other = still.find((p) => p.key === "rosa:0")!;
    const cell = TRACK_CELLS[49];
    expect([moving.x, moving.y, moving.stackSize]).toEqual([cell.x, cell.y, 1]);
    expect([other.x, other.y, other.stackSize]).toEqual([cell.x, cell.y, 1]);
    // Sin animación, las dos se apilan.
    expect(layoutPieces(state).filter((p) => p.stackSize === 2)).toHaveLength(2);
    // El orden de los nodos no cambia (las transiciones no se cortan).
    expect(still.map((p) => p.key)).toEqual(layoutPieces(state).map((p) => p.key));
  });
});

describe("simulación: la animación acaba siempre en el estado real", () => {
  it("200 acciones de 5 partidas: saltos de una casilla y último fotograma = estado del motor", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

    for (let g = 0; g < 5; g++) {
      let state = createGame(IDS);
      for (let i = 0; i < 200 && state.status === "playing"; i++) {
        const action: GameAction =
          state.dice === null && state.pendingBonus === null
            ? { type: "roll", playerId: state.turn, value: 1 + Math.floor(random() * 6) }
            : { type: "move", playerId: state.turn, pieceIndex: getAvailableMoves(state)[0] };
        const result = run(state, action);
        const frames = buildAnimation(state, result.events, result.state);
        const changed = JSON.stringify(positionsOf(state)) !== JSON.stringify(positionsOf(result.state));

        expect(frames.length > 0).toBe(changed);
        if (frames.length > 0) expect(frames.at(-1)!.positions).toEqual(positionsOf(result.state));
        for (const event of result.events) {
          if (event.type !== "piece_moved" || event.from.steps < 0) continue;
          const path = stepsOfMoving(frames, event.playerId, event.pieceIndex);
          const journey = [event.from.steps, ...path].map(stepsToJourney);
          for (let k = 1; k < journey.length; k++) expect(journey[k] - journey[k - 1]).toBe(1);
        }
        state = result.state;
      }
    }
  });
});
