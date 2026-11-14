import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GameView } from "@/components/game/GameView";
import { createDemoMatch } from "@/lib/board/demo";
import { createGame } from "@/lib/engine";
import type { GameResponse } from "@/lib/game/api";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { BoardDemo } from "../BoardDemo";

const game = (extra: Partial<GameResponse> = {}): GameResponse => {
  const state = createGame([...CHARACTER_IDS]);
  return {
    id: "3f39156e-12ec-4bd0-86af-58a5ccf8cd66",
    version: 1,
    status: state.status,
    winner: state.winner,
    state,
    lastAction: null,
    lastEvents: [],
    createdAt: "2026-11-11T00:00:00+00:00",
    updatedAt: "2026-11-11T00:57:44.700837+00:00",
    finishedAt: null,
    ...extra,
  };
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("/tablero: demo sobre GameView", () => {
  it("se ve como la partida real, con los personajes, el chat, las jugadas, los controles y sin id ni fechas", async () => {
    const initial = await createDemoMatch();
    const html = renderToStaticMarkup(<BoardDemo initial={initial} />);
    for (const label of ["Estado", "Tablero", "Turno, jugadores y chat", "Jugadas y datos de la partida", "Chat de los personajes", "Datos de la partida"]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    for (const name of ["Brava", "Don Ernesto", "Abuela Pilar", "Chispa"]) expect(html).toContain(name);
    expect(html).not.toMatch(/>Rosa<|>Morado<|>Verde<|>Azul</);
    expect(html).toContain("Demostración local");
    expect(html).toContain("Demostración en este navegador");
    expect(html).not.toContain(">ID<");
    for (const button of ["Pausar", "Siguiente acción", "Lanzar dado", "Reiniciar demo", "Partida nueva", "Ejemplo"]) expect(html).toContain(button);
    // Empieza reproduciéndose.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Pausar/);
    // Los mensajes iniciales (de versiones ya mostradas) están en el chat.
    expect(html).toContain(escape(initial.messages.at(-1)!.text));
  });

  it("GameView sin las props de la demo se ve exactamente igual que antes (id, fechas y sin controles)", () => {
    const html = renderToStaticMarkup(<GameView game={game()} />);
    expect(html).toContain(">ID<");
    expect(html).toContain("3f39156e-12ec-4bd0-86af-58a5ccf8cd66");
    expect(html).toContain("Actualizada");
    expect(html).not.toContain("Demostración");
    expect(html).not.toContain("Siguiente acción");
    expect(renderToStaticMarkup(<GameView game={game()} demo={false} controls={undefined} />)).toBe(html);
  });
});
