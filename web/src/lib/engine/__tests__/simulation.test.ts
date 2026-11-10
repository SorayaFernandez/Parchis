// Partidas completas con dados y decisiones pseudoaleatorias (con semilla):
// comprueba que siempre terminan y que el estado es coherente en todo momento.

import { describe, expect, it } from "vitest";
import { getRealBoardPosition, isOnMainTrack, isSafeCell } from "../board";
import { FINAL_POSITION } from "../constants";
import { applyAction, createGame, getAvailableMoves } from "../engine";
import type { GameState } from "../types";
import { stateForSteps } from "./helpers";

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Comprobaciones sin `expect` (se ejecutan en cada acción y `expect` es lento).
function checkInvariants(state: GameState) {
  const fail = (msg: string) => {
    throw new Error(`Invariante rota: ${msg}\n${JSON.stringify(state)}`);
  };
  const perCell = new Map<number, number>();
  for (const player of state.players) {
    for (const piece of player.pieces) {
      if (piece.state !== stateForSteps(piece.steps)) fail("estado/steps incoherentes");
      if (piece.steps < -1 || piece.steps > FINAL_POSITION) fail("steps fuera de rango");
      if (piece.state === "track" && piece.steps > 63) fail("ficha pasada la entrada");
      if (isOnMainTrack(piece)) {
        const cell = getRealBoardPosition(player.color, piece.steps);
        perCell.set(cell, (perCell.get(cell) ?? 0) + 1);
      }
    }
  }
  for (const [cell, count] of perCell) {
    if (count > (isSafeCell(cell) ? 2 : 4)) fail(`demasiadas fichas en ${cell}`);
  }
}

describe("simulación de partidas completas", () => {
  for (const players of [2, 3, 4]) {
    it(`20 partidas de ${players} jugadores terminan con un estado coherente`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const random = mulberry32(seed * 1000 + players);
        let state = createGame(["a", "b", "c", "d"].slice(0, players));
        let actions = 0;

        while (state.status === "playing") {
          if (++actions > 20_000) throw new Error(`La partida ${seed} no termina`);
          const moves = getAvailableMoves(state);
          const action =
            state.dice === null && state.pendingBonus === null
              ? { type: "roll" as const, playerId: state.turn, value: 1 + Math.floor(random() * 6) }
              : {
                  type: "move" as const,
                  playerId: state.turn,
                  pieceIndex: moves[Math.floor(random() * moves.length)],
                };
          const result = applyAction(state, action);
          if (!result.ok) throw new Error(`Acción rechazada: ${result.error}`);
          state = result.state;
          checkInvariants(state);
        }

        expect(state.ranking).toHaveLength(players);
        expect(new Set(state.ranking).size).toBe(players);
        expect(state.winner).toBe(state.ranking[0]);
      }
    });
  }
});
