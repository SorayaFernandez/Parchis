import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyAction, createGame, type GameState } from "@/lib/engine";
import type { GameResponse } from "@/lib/game/api";
import { CHARACTER_IDS } from "@/lib/game/characters";

// RetryButton usa el router de la app; fuera de Next se simula.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { GameScreen } = await import("../GameScreen");

const ID = "3f39156e-12ec-4bd0-86af-58a5ccf8cd66";

function game(state: GameState, extra: Partial<GameResponse> = {}): GameResponse {
  return {
    id: ID,
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
}

const render = (g: GameResponse) => renderToStaticMarkup(<GameScreen result={{ kind: "ok", game: g }} />);

describe("página /partida/[id]: estados", () => {
  it("partida inexistente: mensaje y enlace al inicio, sin reintentar", () => {
    const html = renderToStaticMarkup(<GameScreen result={{ kind: "not_found" }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Partida no encontrada");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Reintentar");
  });

  it("error de carga: mensaje y botón de reintentar", () => {
    const html = renderToStaticMarkup(
      <GameScreen result={{ kind: "error", message: "El almacenamiento de partidas no está disponible ahora mismo." }} />,
    );
    expect(html).toContain("No se ha podido cargar la partida");
    expect(html).toContain("El almacenamiento de partidas no está disponible ahora mismo.");
    expect(html).toContain("Reintentar");
  });
});

describe("página /partida/[id]: partida en curso", () => {
  it("versión 1: en curso, turno de Rosa, 16 fichas, los 4 personajes y sin jugadas; sin botón de tirar", () => {
    const html = render(game(createGame([...CHARACTER_IDS])));
    expect(html).toContain("En curso");
    expect(html).toContain("Turno de");
    expect(html).not.toContain("Partida terminada");
    expect(html.match(/<title>Ficha /g)).toHaveLength(16);
    for (const name of ["Rosa", "Morado", "Verde", "Azul"]) expect(html).toContain(name);
    expect(html).toContain("Rosa puede lanzar el dado");
    expect(html).toContain("Todavía no se ha jugado ningún turno.");
    expect(html).not.toContain("Lanzar dado");
  });

  it("muestra las posiciones reales, el dado y la última jugada (acción + eventos)", () => {
    const start = createGame([...CHARACTER_IDS]);
    const rolled = applyAction(start, { type: "roll", playerId: "ai-pink", value: 5 });
    if (!rolled.ok) throw new Error(rolled.error);
    const moved = applyAction(rolled.state, { type: "move", playerId: "ai-pink", pieceIndex: 0 });
    if (!moved.ok) throw new Error(moved.error);
    const html = render(
      game(moved.state, { version: 3, lastAction: { type: "move", playerId: "ai-pink", pieceIndex: 0 }, lastEvents: moved.events }),
    );
    expect(html).toContain("Ficha 1 rosa, en la casilla 39"); // posición real: salida de pink
    expect(html).toContain("Rosa mueve la ficha 1");
    expect(html).toContain("Rosa saca una ficha de casa");
    expect(html).toContain("Azul puede lanzar el dado"); // turno siguiente
    expect(html).toContain("Dado: 5"); // último valor del dado
    expect(html).toContain(">3<"); // versión
  });

  it("con dado pendiente resalta las fichas que se pueden mover", () => {
    const rolled = applyAction(createGame([...CHARACTER_IDS]), { type: "roll", playerId: "ai-pink", value: 5 });
    if (!rolled.ok) throw new Error(rolled.error);
    const html = render(game(rolled.state, { version: 2 }));
    expect(html).toContain("Rosa elige ficha (4 posibles)");
    expect(html.match(/stroke="white"/g)).toHaveLength(4);
  });
});

describe("página /partida/[id]: partida terminada", () => {
  it("se distingue: resultado con ganador y clasificación, sin 'En curso' ni fichas resaltadas", () => {
    const state: GameState = {
      ...createGame([...CHARACTER_IDS]),
      status: "finished",
      winner: "ai-green",
      ranking: ["ai-green", "ai-pink", "ai-purple", "ai-blue"],
    };
    const html = render(game(state, { version: 646, finishedAt: "2026-11-11T00:59:07.109624+00:00" }));
    expect(html).toContain("Partida terminada");
    expect(html).toMatch(/Gana.*Verde/);
    for (const [place, name] of [["1º", "Verde"], ["2º", "Rosa"], ["3º", "Morado"], ["4º", "Azul"]]) {
      expect(html).toMatch(new RegExp(`${place}</span>.*?${name}`));
    }
    expect(html).not.toContain("En curso");
    expect(html).not.toContain('stroke="white"');
    expect(html).toContain("Terminada");
    expect(html).toContain("11/11/26, 1:59:07"); // finished_at en hora de Madrid
  });
});
