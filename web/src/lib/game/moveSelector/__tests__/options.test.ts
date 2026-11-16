import { describe, expect, it } from "vitest";
import { applyAction, createGame, getAvailableMoves, type GameEvent, type GameState } from "@/lib/engine";
import { setup } from "@/lib/engine/__tests__/helpers";
import { createSeededRandom, decideAction } from "@/lib/game/ai";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { buildMoveDecision, pieceForOption, type MoveDecision, type PositionFact } from "../options";

// Ids de los personajes por color (createGame asigna pink, purple, green, blue en ese orden).
const [PINK, , GREEN, BLUE] = CHARACTER_IDS;

/** Partida con las fichas colocadas (por `steps`; -1 = casa), turno de Brava (pink) y el dado indicado. */
function game(pieces: Parameters<typeof setup>[0], dice: number | null, extra: Partial<GameState> = {}): GameState {
  const state = setup(pieces, CHARACTER_IDS);
  return { ...state, turn: PINK, dice, ...extra };
}

const decide = (state: GameState): MoveDecision => {
  const d = buildMoveDecision(state);
  expect(d).not.toBeNull();
  return d!;
};

describe("buildMoveDecision: opciones legales", () => {
  it("una sola opción legal: A → esa ficha", () => {
    const d = decide(game({ pink: [20, -1, -1, -1] }, 3));
    expect(d.options.map((o) => [o.id, o.pieceIndex])).toEqual([["A", 0]]);
    expect(d.source).toEqual({ tipo: "dado", valor: 3 });
    expect(d.obligation).toBeNull();
  });

  it("varias opciones: A, B… en orden de ficha, con la correspondencia exacta con pieceIndex", () => {
    const state = game({ pink: [-1, 20, -1, 30] }, 3);
    const d = decide(state);
    expect(d.options.map((o) => [o.id, o.pieceIndex])).toEqual([["A", 1], ["B", 3]]);
    expect(d.options.map((o) => o.pieceIndex)).toEqual(getAvailableMoves(state));
    expect(pieceForOption(d, "A")).toBe(1);
    expect(pieceForOption(d, "B")).toBe(3);
    expect(pieceForOption(d, "C")).toBeNull();
    expect(pieceForOption(d, "a")).toBeNull();
    expect(d.options[0].facts).toMatchObject({ desde: { zone: "recorrido", casillas: 20 }, hasta: { zone: "recorrido", casillas: 23 }, avance: 3 });
  });

  it("captura: jugador capturado y bonus de +20, como en applyAction", () => {
    // Brava en la casilla global 59 (steps 20); con un 3 cae en la 62, donde está Chispa (steps 6).
    const state = game({ pink: [20, -1, -1, -1], blue: [6, -1, -1, -1] }, 3);
    const [a] = decide(state).options;
    const real = applyAction(state, { type: "move", playerId: PINK, pieceIndex: 0 });
    expect(real.ok && real.events.some((e) => e.type === "piece_captured" && e.victimId === BLUE)).toBe(true);
    expect(a.facts).toMatchObject({ captura: { jugador: BLUE }, bonusGanado: { cantidad: 20, motivo: "capture" }, casillaSegura: false });
  });

  it("llegada a la meta con la tirada exacta: bonus de +10 si otra ficha puede usarlo; si no, se pierde", () => {
    // Con otra ficha en el recorrido, el +10 se concede (bonus_granted).
    const d = decide(game({ pink: [72, 20, -1, -1] }, 3));
    const meta = d.options.find((o) => o.pieceIndex === 0)!;
    expect(meta.facts).toMatchObject({ desde: { zone: "pasillo", casilla: 5 }, hasta: { zone: "meta" }, llegaAMeta: true, bonusGanado: { cantidad: 10, motivo: "goal" }, amenazas: null, presas: null });
    // Si ninguna otra ficha puede usar el +10, el motor lo pierde (bonus_lost) y la opción no lo anuncia.
    const state = game({ pink: [72, -1, -1, -1] }, 3);
    const [sola] = decide(state).options;
    const real = applyAction(state, { type: "move", playerId: PINK, pieceIndex: 0 });
    expect(real.ok && real.events.some((e) => e.type === "bonus_lost")).toBe(true);
    expect(sola.facts).toMatchObject({ llegaAMeta: true, bonusGanado: null });
  });

  it("entrada al pasillo final y casilla segura", () => {
    // steps 62 + 3: entrada (63) y casillas de color 68, 69.
    const [pasillo] = decide(game({ pink: [62, -1, -1, -1] }, 3)).options;
    expect(pasillo.facts).toMatchObject({ hasta: { zone: "pasillo", casilla: 2 }, entraEnPasillo: true, casillaSegura: false, amenazas: null });
    // steps 20 (global 59) + 4 → global 63, casilla segura.
    const [seguro] = decide(game({ pink: [20, -1, -1, -1] }, 4)).options;
    expect(seguro.facts).toMatchObject({ hasta: { zone: "recorrido", casillas: 24 }, casillaSegura: true, entraEnPasillo: false });
  });

  it("formar una barrera propia", () => {
    // Fichas en steps 20 y 23: con un 3, la primera se une a la segunda (global 62, casilla normal).
    const d = decide(game({ pink: [20, 23, -1, -1] }, 3));
    expect(d.options.find((o) => o.pieceIndex === 0)!.facts).toMatchObject({ formaBarrera: true, rompeBarrera: false });
    expect(d.options.find((o) => o.pieceIndex === 1)!.facts).toMatchObject({ formaBarrera: false, rompeBarrera: false });
  });

  it("amenazas y presas: simuladas con el motor para cada valor del dado", () => {
    // Brava cae en la global 62. Abuela Pilar (verde) está 2 casillas por detrás (global 60) y Don Ernesto
    // (morado) 4 por delante (global 66, casilla normal).
    const state = game({ pink: [20, -1, -1, -1], green: [38, -1, -1, -1], purple: [61, -1, -1, -1] }, 3);
    const [a] = decide(state).options;
    expect(a.facts.amenazas).toBe(1);
    expect(a.facts.presas).toBe(1);
    // Comprobación independiente con el motor: tras el movimiento, Pilar con un 2 captura la ficha de
    // Brava y Brava con un 4 captura la de Don Ernesto.
    const after = applyAction(state, { type: "move", playerId: PINK, pieceIndex: 0 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const pilarTurn = applyAction({ ...after.state, turn: GREEN, dice: 2, pendingBonus: null }, { type: "move", playerId: GREEN, pieceIndex: 0 });
    expect(pilarTurn.ok && pilarTurn.events.some((e) => e.type === "piece_captured" && e.victimId === PINK && e.victimPieceIndex === 0)).toBe(true);
    const bravaTurn = applyAction({ ...after.state, turn: PINK, dice: 4, pendingBonus: null }, { type: "move", playerId: PINK, pieceIndex: 0 });
    expect(bravaTurn.ok && bravaTurn.events.some((e) => e.type === "piece_captured" && e.victimId === CHARACTER_IDS[1])).toBe(true);
    // Sin rivales cerca: nada.
    const [b] = decide(game({ pink: [20, -1, -1, -1] }, 3)).options;
    expect(b.facts).toMatchObject({ amenazas: 0, presas: 0 });
  });

  it("bonus pendiente de +20 y de +10: se juega el bonus y lo indica la decisión", () => {
    const capture = decide(game({ pink: [20, 30, -1, -1] }, null, { pendingBonus: { playerId: PINK, amount: 20, reason: "capture", fromSix: false } }));
    expect(capture.source).toEqual({ tipo: "bonus", cantidad: 20, motivo: "capture" });
    expect(capture.options.every((o) => o.facts.avance === 20)).toBe(true);
    const goal = decide(game({ pink: [20, 30, -1, -1] }, null, { pendingBonus: { playerId: PINK, amount: 10, reason: "goal", fromSix: false } }));
    expect(goal.source).toEqual({ tipo: "bonus", cantidad: 10, motivo: "goal" });
    expect(goal.options.map((o) => o.facts.hasta)).toEqual([{ zone: "recorrido", casillas: 30 }, { zone: "recorrido", casillas: 40 }]);
  });

  it("obligación del 5: solo salidas de casa (la ficha del recorrido no se ofrece)", () => {
    const state = game({ pink: [-1, 20, -1, -1] }, 5);
    const d = decide(state);
    expect(d.obligation).toBe("sacar ficha de casa");
    expect(d.options.map((o) => o.pieceIndex)).toEqual([0, 2, 3]);
    expect(d.options.every((o) => o.facts.saleDeCasa && o.facts.desde.zone === "casa")).toBe(true);
    expect(d.options.map((o) => o.pieceIndex)).toEqual(getAvailableMoves(state));
  });

  it("obligación del 6: solo abrir la barrera propia", () => {
    // Barrera de Brava en steps 20 (global 59, casilla normal); la ficha de steps 30 no se ofrece.
    const d = decide(game({ pink: [20, 20, 30, -1] }, 6));
    expect(d.obligation).toBe("abrir una barrera propia");
    expect(d.options.map((o) => o.pieceIndex)).toEqual([0, 1]);
    expect(d.options.every((o) => o.facts.rompeBarrera && o.facts.repiteTirada)).toBe(true);
  });

  it("sin obligación con un 5 sin fichas en casa ni con un 6 sin barreras", () => {
    expect(decide(game({ pink: [20, 30, 40, 50] }, 5)).obligation).toBeNull();
    expect(decide(game({ pink: [20, 30, -1, -1] }, 6)).obligation).toBeNull();
  });

  it("nada que decidir: partida terminada, sin dado ni bonus o sin movimientos legales", () => {
    expect(buildMoveDecision({ ...game({ pink: [20, -1, -1, -1] }, 3), status: "finished" })).toBeNull();
    expect(buildMoveDecision(game({ pink: [20, -1, -1, -1] }, null))).toBeNull();
    expect(buildMoveDecision(game({}, 3))).toBeNull(); // todas en casa y sin un 5
  });
});

/** Posición de una ficha según el evento `piece_moved` del motor. */
const factFor = (p: { state: string; steps: number }): PositionFact =>
  p.state === "base" ? { zone: "casa" } : p.state === "finished" ? { zone: "meta" } : p.state === "final" ? { zone: "pasillo", casilla: p.steps - 67 } : { zone: "recorrido", casillas: p.steps };

describe("las opciones coinciden con applyAction en partidas simuladas", () => {
  it("en 75 decisiones de cada una de 2 partidas: mismas fichas que getAvailableMoves y hechos iguales a los eventos reales", { timeout: 30_000 }, () => {
    const PER_GAME = 75;
    const perGame: number[] = [];
    for (const seed of [3, 11]) {
      let checked = 0;
      const random = createSeededRandom(seed);
      let state = createGame([...CHARACTER_IDS]);
      for (let step = 0; step < 4000 && state.status === "playing"; step++) {
        const decision = buildMoveDecision(state);
        const legal = getAvailableMoves(state);
        if (decision === null) {
          expect(state.dice === null && state.pendingBonus === null ? true : legal.length === 0).toBe(true);
        } else if (checked < PER_GAME) {
          checked++;
          expect(decision.options.map((o) => o.pieceIndex)).toEqual(legal);
          expect(decision.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"].slice(0, legal.length));
          for (const option of decision.options) {
            const real = applyAction(state, { type: "move", playerId: state.turn, pieceIndex: option.pieceIndex });
            expect(real.ok).toBe(true);
            if (!real.ok) continue;
            const has = (type: GameEvent["type"]) => real.events.some((e) => e.type === type);
            const moved = real.events.find((e): e is Extract<GameEvent, { type: "piece_moved" }> => e.type === "piece_moved")!;
            const captured = real.events.find((e): e is Extract<GameEvent, { type: "piece_captured" }> => e.type === "piece_captured");
            const bonus = real.events.find((e): e is Extract<GameEvent, { type: "bonus_granted" }> => e.type === "bonus_granted");
            const f = option.facts;
            expect(f.desde).toEqual(factFor(moved.from));
            expect(f.hasta).toEqual(factFor(moved.to));
            expect(f.avance).toBe(moved.distance);
            expect(f.captura).toEqual(captured ? { jugador: captured.victimId } : null);
            expect(f.llegaAMeta).toBe(has("piece_reached_goal"));
            expect(f.bonusGanado).toEqual(bonus ? { cantidad: bonus.amount, motivo: bonus.reason } : null);
            expect(f.repiteTirada).toBe(has("roll_again"));
            // Amenazas y presas solo cuando la ficha queda en el recorrido común.
            expect(f.amenazas === null).toBe(moved.to.state !== "track");
          }
        }
        const action = decideAction(state, () => 1 + Math.floor(random() * 6), random);
        const result = applyAction(state, action);
        expect(result.ok).toBe(true);
        if (!result.ok) break;
        state = result.state;
      }
      perGame.push(checked);
    }
    // Las dos partidas aportan sus decisiones (cada una tiene más de 400).
    expect(perGame).toEqual([PER_GAME, PER_GAME]);
  });
});
