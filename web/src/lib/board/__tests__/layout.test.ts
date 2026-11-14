import { describe, expect, it } from "vitest";
import {
  FINAL_POSITION,
  HOME_ENTRIES,
  HOME_ENTRY_STEPS,
  createGame,
  type GameState,
} from "@/lib/engine";
import { createShowcaseState } from "../demo";
import {
  BASE_SLOTS,
  CELL_LENGTH,
  CELL_WIDTH,
  GOAL_SLOTS,
  HOME_STRETCH,
  TRACK_CELLS,
  isStretchVertical,
} from "../geometry";
import { PIECE_HALO_RATIO, PIECE_RING_RATIO, PIECE_SIZE, getPieceSlot, layoutPieces, stackSpacing } from "../layout";

const positions = (state: GameState) => layoutPieces(state).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);

describe("geometría", () => {
  it("tiene 68 casillas de recorrido y 7 de pasillo por color", () => {
    expect(TRACK_CELLS).toHaveLength(68);
    for (const stretch of Object.values(HOME_STRETCH)) expect(stretch).toHaveLength(7);
  });

  it("los pasillos blue y green empiezan en la primera celda junto a su entrada (corrección)", () => {
    // Entrada blue = casilla 51 (borde izquierdo), green = 17 (borde derecho).
    // La primera celda del pasillo está a una casilla (36 u. en 732) de la entrada.
    const step = (36 * 1600) / 732;
    expect(HOME_STRETCH.blue[0].x - TRACK_CELLS[51].x).toBeCloseTo(step, 5);
    expect(TRACK_CELLS[17].x - HOME_STRETCH.green[0].x).toBeCloseTo(step, 5);
    expect(HOME_STRETCH.pink[0].y - TRACK_CELLS[34].y).toBeCloseTo(step, 5);
    expect(TRACK_CELLS[0].y - HOME_STRETCH.purple[0].y).toBeCloseTo(step, 5);
  });
});

describe("posiciones de las fichas", () => {
  it("convierte steps en casilla lógica con el convenio del motor", () => {
    expect(getPieceSlot("pink", 2, -1)).toEqual({ kind: "base", color: "pink", pieceIndex: 2 });
    expect(getPieceSlot("pink", 0, 0)).toEqual({ kind: "track", cell: 39 });
    expect(getPieceSlot("purple", 0, 63)).toEqual({ kind: "track", cell: 0 });
    expect(getPieceSlot("blue", 0, 68)).toEqual({ kind: "stretch", color: "blue", index: 0 });
    expect(getPieceSlot("blue", 0, 74)).toEqual({ kind: "stretch", color: "blue", index: 6 });
    expect(getPieceSlot("green", 1, 75)).toEqual({ kind: "goal", color: "green", pieceIndex: 1 });
  });

  it("al empezar, las 16 fichas están en sus casas, sin solaparse", () => {
    const layout = layoutPieces(createGame(["a", "b", "c", "d"]));
    expect(layout).toHaveLength(16);
    expect(new Set(layout.map((p) => p.key)).size).toBe(16);
    expect(new Set(positions(createGame(["a", "b", "c", "d"]))).size).toBe(16);
    const pink = layout.filter((p) => p.color === "pink");
    expect(pink.map(({ x, y }) => ({ x, y }))).toEqual(BASE_SLOTS.pink);
  });

  it("las fichas apiladas se dibujan una sola vez y en posiciones distintas (corrección)", () => {
    const state = createShowcaseState();
    const layout = layoutPieces(state);
    expect(layout).toHaveLength(16);
    expect(new Set(layout.map((p) => p.key)).size).toBe(16);
    expect(new Set(positions(state)).size).toBe(16);

    // Barrera purple en la casilla 44 (brazo horizontal): se reparte en vertical.
    const blockade = layout.filter((p) => p.slot.kind === "track" && p.slot.cell === 44);
    expect(blockade).toHaveLength(2);
    expect(blockade.every((p) => p.stackSize === 2 && p.x === TRACK_CELLS[44].x)).toBe(true);
    expect(Math.abs(blockade[0].y - blockade[1].y)).toBeLessThanOrEqual(CELL_LENGTH);
  });

  it("hasta cuatro fichas caben dentro del eje largo de la casilla", () => {
    const state = createGame(["a", "b", "c", "d"]);
    for (const player of state.players) {
      // Todas en la casilla 30 (brazo vertical) para probar el reparto.
      const steps = (30 - { pink: 39, purple: 5, green: 22, blue: 56 }[player.color] + 68) % 68;
      player.pieces[0] = { steps, state: "track", arrivalOrder: 1 };
    }
    const stack = layoutPieces(state).filter((p) => p.slot.kind === "track");
    expect(stack).toHaveLength(4);
    const xs = stack.map((p) => p.x).sort((a, b) => a - b);
    // Bordes exteriores (centro ± radio visible) dentro de la casilla.
    expect(xs[3] - xs[0] + stack[0].size).toBeLessThanOrEqual(CELL_LENGTH);
    expect(new Set(stack.map((p) => p.y)).size).toBe(1);
  });

  it("con 1, 2 o 3 fichas tampoco se salen de la casilla ni se solapan", () => {
    for (const n of [1, 2, 3]) {
      const state = createGame(["a", "b", "c", "d"]);
      state.players.slice(0, n).forEach((player) => {
        const steps = (30 - { pink: 39, purple: 5, green: 22, blue: 56 }[player.color] + 68) % 68;
        player.pieces[0] = { steps, state: "track", arrivalOrder: 1 };
      });
      const stack = layoutPieces(state).filter((p) => p.slot.kind === "track");
      const xs = stack.map((p) => p.x).sort((a, b) => a - b);
      expect(xs.at(-1)! - xs[0] + stack[0].size).toBeLessThanOrEqual(CELL_LENGTH);
      expect(stack[0].size).toBeLessThan(CELL_WIDTH);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(stack[0].size - 1);
    }
  });

  it("una ficha sola cabe en los círculos de casa (r = 22 en board-base.svg ≈ 35)", () => {
    const [piece] = layoutPieces(createGame(["a", "b"]));
    expect(piece.size / 2).toBeLessThan(22 * 1.6);
  });
});

describe("tramo final en el tablero: entrada + 7 casillas de color + meta", () => {
  const STEP = (36 * 1600) / 732; // distancia entre centros de casillas contiguas
  const CENTER = 800;

  for (const color of ["pink", "purple", "green", "blue"] as const) {
    it(`${color}: entrada ${HOME_ENTRIES[color] || 68}, 7 casillas seguidas hacia el centro y meta en su triángulo`, () => {
      const entry = TRACK_CELLS[HOME_ENTRIES[color]];
      const section = [entry, ...HOME_STRETCH[color]];
      expect(section).toHaveLength(8);

      // Las 8 casillas están alineadas, son contiguas y se acercan al centro.
      const vertical = isStretchVertical(color);
      for (let i = 1; i < section.length; i++) {
        const [a, b] = [section[i - 1], section[i]];
        expect(vertical ? a.x : a.y).toBeCloseTo(vertical ? b.x : b.y, 5);
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(STEP, 5);
        expect(Math.hypot(b.x - CENTER, b.y - CENTER)).toBeLessThan(Math.hypot(a.x - CENTER, a.y - CENTER));
      }

      // La meta va más allá de la última casilla de color, dentro del triángulo central.
      const last = section[7];
      for (const goal of GOAL_SLOTS[color]) {
        expect(Math.hypot(goal.x - CENTER, goal.y - CENTER)).toBeLessThan(Math.hypot(last.x - CENTER, last.y - CENTER));
      }

      // Mapeo desde el motor: entrada (63), 68..74 en orden y 75 en la meta.
      expect(getPieceSlot(color, 0, HOME_ENTRY_STEPS)).toEqual({ kind: "track", cell: HOME_ENTRIES[color] });
      for (let i = 0; i < 7; i++) {
        expect(getPieceSlot(color, 0, 68 + i)).toEqual({ kind: "stretch", color, index: i });
      }
      expect(getPieceSlot(color, 0, FINAL_POSITION)).toEqual({ kind: "goal", color, pieceIndex: 0 });
    });
  }
});

describe("tamaño de las fichas: legibles y sin solaparse", () => {
  /** Las fichas de la casilla 30 (brazo vertical), con `n` jugadores en ella. */
  const stackOf = (n: number) => {
    const state = createGame(["a", "b", "c", "d"]);
    state.players.slice(0, n).forEach((player) => {
      const steps = (30 - { pink: 39, purple: 5, green: 22, blue: 56 }[player.color] + 68) % 68;
      player.pieces[0] = { steps, state: "track", arrivalOrder: 1 };
    });
    return layoutPieces(state).filter((p) => p.slot.kind === "track");
  };

  it("una ficha sola, con su anillo de resaltado (trazo 3), cabe en el eje corto de la casilla", () => {
    expect(PIECE_SIZE).toBe(46);
    expect(PIECE_SIZE * PIECE_RING_RATIO + 3).toBeLessThan(CELL_WIDTH);
  });

  it("en casa, la ficha con su halo cabe en el círculo (r = 22 en board-base.svg ≈ 35)", () => {
    const [piece] = layoutPieces(createGame(["a", "b"]));
    expect(piece.slot.kind).toBe("base");
    expect((piece.size * PIECE_HALO_RATIO) / 2).toBeLessThanOrEqual(22 * 1.6);
  });

  it("apiladas (2, 3 y 4): más pequeñas, dentro de la casilla y sin que se toquen las fichas ni sus halos", () => {
    let previous = PIECE_SIZE;
    for (const n of [2, 3, 4]) {
      const stack = stackOf(n);
      expect(stack).toHaveLength(n);
      const size = stack[0].size;
      expect(size).toBeLessThan(previous);
      // Legibles: la más pequeña (4 en una casilla) no baja de 24 unidades.
      expect(size).toBeGreaterThanOrEqual(24);
      previous = size;
      const xs = stack.map((p) => p.x).sort((a, b) => a - b);
      expect(xs.at(-1)! - xs[0] + size).toBeLessThanOrEqual(CELL_LENGTH + 1e-9);
      for (let i = 1; i < xs.length; i++) {
        const gap = xs[i] - xs[i - 1];
        expect(gap).toBeCloseTo(stackSpacing(n, size), 9);
        expect(gap).toBeGreaterThanOrEqual(size * PIECE_HALO_RATIO - 0.1);
      }
    }
  });

  it("en el ejemplo de /tablero (casa, salida, barreras, pasillos y meta) ninguna ficha se solapa con otra", () => {
    const pieces = layoutPieces(createShowcaseState());
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        expect(distance, `${a.key} / ${b.key}`).toBeGreaterThanOrEqual((a.size + b.size) / 2 - 0.1);
      }
    }
  });
});
