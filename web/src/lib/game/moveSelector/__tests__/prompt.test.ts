import { describe, expect, it } from "vitest";
import { setup } from "@/lib/engine/__tests__/helpers";
import type { GameState } from "@/lib/engine";
import { chooseMove } from "@/lib/game/ai";
import { CHARACTER_IDS, CHARACTERS } from "@/lib/game/characters";
import { buildMoveDecision } from "../options";
import { buildMovePrompt, describeStrategy } from "../prompt";
import { getStrategy } from "@/lib/game/characters";

const [BRAVA, ERNESTO, PILAR, CHISPA] = CHARACTERS;

/** Turno de `player` con un 3 y fichas en el recorrido (opciones A y B), con Chispa por delante. */
function stateFor(playerId: string): GameState {
  const color = CHARACTERS.find((c) => c.id === playerId)!.color;
  const base = setup({ [color]: [20, 30, -1, -1], ...(color === "blue" ? {} : { blue: [6, -1, -1, -1] }) }, CHARACTER_IDS);
  return { ...base, turn: playerId, dice: 3 };
}

const promptFor = (playerId: string) => {
  const state = stateFor(playerId);
  const decision = buildMoveDecision(state)!;
  const [system, user] = buildMovePrompt(state, decision);
  const json = JSON.parse(user.content.split("\n")[1]);
  return { state, decision, system: system.content, user: user.content, json };
};

describe("buildMovePrompt", () => {
  it("quién decide, la respuesta exacta pedida y solo los identificadores legales", () => {
    const { system, decision } = promptFor(BRAVA.id);
    expect(system).toContain("Eres Brava");
    expect(system).toContain("Elige exactamente una de las opciones legales: A, B. No hay otras jugadas posibles.");
    expect(system).toContain('Responde solo con un objeto JSON con este formato: {"choice":"<identificador>"}');
    // El ejemplo no usa ningún identificador real (inclinaría al modelo hacia esa opción).
    for (const id of ["A", "B", "C", "D"]) expect(system).not.toContain(`{"choice":"${id}"}`);
    expect(decision.options.map((o) => o.id)).toEqual(["A", "B"]);
  });

  it("el estado relevante: lo que se juega, la obligación, el progreso de cada jugador y las opciones con sus hechos", () => {
    const { json, decision } = promptFor(BRAVA.id);
    expect(json.jugada).toEqual({ tipo: "dado", valor: 3 });
    expect(json.obligacion).toBeNull();
    expect(json.jugadores.map((p: { nombre: string }) => p.nombre)).toEqual(["Brava", "Don Ernesto", "Abuela Pilar", "Chispa"]);
    expect(json.jugadores[0]).toMatchObject({ tu: true, enCasa: 2, enRecorrido: 2, enPasillo: 0, enMeta: 0 });
    expect(json.opciones.map((o: { id: string }) => o.id)).toEqual(["A", "B"]);
    // Las opciones del prompt son las de la decisión, con sus hechos simulados.
    for (const [i, option] of decision.options.entries()) {
      expect(json.opciones[i]).toMatchObject({
        id: option.id,
        avance: option.facts.avance,
        saleDeCasa: option.facts.saleDeCasa,
        llegaAMeta: option.facts.llegaAMeta,
        amenazas: option.facts.amenazas,
        presas: option.facts.presas,
      });
    }
    expect(json.opciones[0]).toMatchObject({ desde: "recorrido (20 de 63 casillas)", hasta: "recorrido (23 de 63 casillas)", captura: "Chispa", bonusGanado: "+20 por captura" });
  });

  it("bonus pendiente: el prompt dice que se juega un bonus y por qué", () => {
    const state: GameState = { ...stateFor(BRAVA.id), dice: null, pendingBonus: { playerId: BRAVA.id, amount: 20, reason: "capture", fromSix: false } };
    const [, user] = buildMovePrompt(state, buildMoveDecision(state)!);
    expect(JSON.parse(user.content.split("\n")[1]).jugada).toEqual({ tipo: "bonus", casillas: 20, motivo: "captura" });
  });

  it("nunca la ficha interna (pieceIndex), la recomendación ni la puntuación de la estrategia local", () => {
    for (const c of CHARACTERS) {
      const { state, decision, system, user } = promptFor(c.id);
      const text = `${system}\n${user}`;
      expect(text).not.toMatch(/pieceIndex|recomend|puntuaci|score|chooseMove|mejor jugada|ficha \d/i);
      // La elección local existe, pero no aparece como dato en el prompt.
      const local = chooseMove(state, decision.options.map((o) => o.pieceIndex));
      expect(decision.options.some((o) => o.pieceIndex === local)).toBe(true);
      expect(JSON.parse(user.split("\n")[1]).opciones.every((o: Record<string, unknown>) => !("pieceIndex" in o) && !("ficha" in o))).toBe(true);
    }
  });

  it("personalidad y perfil estratégico de cada personaje, a partir de sus multiplicadores reales", () => {
    const brava = promptFor(BRAVA.id).system;
    expect(brava).toContain("la agresiva");
    expect(brava).toMatch(/Te importa mucho [^.]*capturar fichas rivales[^.]*acercarse a fichas rivales para cazarlas/);
    expect(brava).toMatch(/Te importa poco [^.]*no dejar fichas a tiro/);
    const ernesto = promptFor(ERNESTO.id).system;
    expect(ernesto).toContain("el estratega");
    expect(ernesto).toMatch(/Te importa mucho [^.]*formar barreras con tus fichas/);
    const pilar = promptFor(PILAR.id).system;
    expect(pilar).toContain("la prudente");
    expect(pilar).toMatch(/Te importa mucho [^.]*dejar las fichas en casillas seguras[^.]*no dejar fichas a tiro/);
    expect(pilar).toContain("No te importa acercarse a fichas rivales para cazarlas.");
    const chispa = promptFor(CHISPA.id).system;
    expect(chispa).toContain("el imprevisible");
    expect(chispa).toMatch(/Te importa mucho [^.]*avanzar cuantas más casillas mejor/);
    expect(chispa).toContain("De vez en cuando eliges una jugada distinta de la más evidente.");
    // Solo Chispa tiene azar.
    for (const c of [BRAVA, ERNESTO, PILAR]) expect(promptFor(c.id).system).not.toContain("distinta de la más evidente");
  });

  it("describeStrategy: perfil neutro y personaje desconocido", () => {
    expect(describeStrategy(getStrategy("desconocido"))).toBe("Juegas equilibrado, sin preferencias especiales.");
  });
});
