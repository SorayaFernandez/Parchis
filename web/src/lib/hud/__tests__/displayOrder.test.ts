import { describe, expect, it } from "vitest";
import { COLORS, TURN_ORDER, createGame } from "@/lib/engine";
import { CHARACTER_IDS, CHARACTER_NAMES } from "@/lib/game/characters";
import { PLAYER_DISPLAY_ORDER, inDisplayOrder } from "../displayOrder";
import { getPlayerSummaries } from "../summary";

describe("orden visual de los jugadores", () => {
  it("Chispa, Don Ernesto, Abuela Pilar y Brava, sin cambiar el estado ni el orden de turnos", () => {
    const state = createGame([...CHARACTER_IDS]);
    const before = JSON.stringify(state);
    const shown = inDisplayOrder(getPlayerSummaries(state));
    expect(shown.map((p) => CHARACTER_NAMES[p.id])).toEqual(["Chispa", "Don Ernesto", "Abuela Pilar", "Brava"]);
    expect(shown.map((p) => p.color)).toEqual(["blue", "purple", "green", "pink"]);
    // Solo presentación: el orden interno y el de los turnos del motor siguen igual.
    expect(JSON.stringify(state)).toBe(before);
    expect(state.players.map((p) => p.color)).toEqual([...COLORS]);
    expect(TURN_ORDER).toEqual(["pink", "blue", "purple", "green"]);
  });

  it("cubre los cuatro colores y salta los que no juegan", () => {
    expect([...PLAYER_DISPLAY_ORDER].sort()).toEqual([...COLORS].sort());
    const shown = inDisplayOrder(getPlayerSummaries(createGame(["a", "b", "c"])));
    expect(shown.map((p) => p.color)).toEqual(["purple", "green", "pink"]);
  });

  it("no modifica la lista que recibe", () => {
    const summaries = getPlayerSummaries(createGame(["a", "b", "c", "d"]));
    const copy = [...summaries];
    inDisplayOrder(summaries);
    expect(summaries).toEqual(copy);
  });
});
