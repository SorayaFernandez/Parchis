// Repositorio en memoria para pruebas: reproduce las reglas del trigger `games_guard`
// (reserva de 20 s con el reloj de la "BD", confirmación con versión + token + reserva vigente).

import type { GameState } from "@/lib/engine";
import type { CommitData, GamesRepository } from "../repository";
import type { StoredGame } from "../schemas";

export const LEASE_MS = 20_000;

interface Row {
  game: StoredGame;
  lockToken: string | null;
  /** ms del reloj de la "BD" */
  processingUntil: number | null;
}

/**
 * Cede el control para que las peticiones "concurrentes" se intercalen como en la red.
 * Con microtareas (no setTimeout) para que funcione también con temporizadores falsos.
 */
const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

export function createMemoryRepository(clock = { now: 0 }) {
  const rows = new Map<string, Row>();
  const calls = { get: 0, claim: 0, commit: 0, release: 0 };
  let nextId = 1;

  const snapshot = (row: Row): StoredGame => structuredClone({
    ...row.game,
    processingUntil: row.processingUntil === null ? null : new Date(row.processingUntil).toISOString(),
  });

  const repository: GamesRepository = {
    async create(state: GameState) {
      await tick();
      const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
      const at = new Date(clock.now).toISOString();
      const game: StoredGame = {
        id, state: structuredClone(state), version: 1, engineVersion: 1, status: state.status, winner: state.winner,
        lastAction: null, lastEvents: [], processingUntil: null, createdAt: at, updatedAt: at, finishedAt: null,
      };
      rows.set(id, { game, lockToken: null, processingUntil: null });
      return snapshot(rows.get(id)!);
    },

    async get(id) {
      calls.get++;
      await tick();
      const row = rows.get(id);
      return row ? snapshot(row) : null;
    },

    async claim(id, version, token) {
      calls.claim++;
      await tick();
      const row = rows.get(id);
      if (!row || row.game.version !== version || row.game.status !== "playing") return null; // 0 filas
      if (row.lockToken !== null && row.processingUntil! > clock.now) return null; // 55P03: reserva vigente
      row.lockToken = token;
      row.processingUntil = clock.now + LEASE_MS;
      return snapshot(row);
    },

    async commit(id, version, token, { state, action, events }: CommitData) {
      calls.commit++;
      await tick();
      const row = rows.get(id);
      if (!row || row.game.version !== version || row.lockToken !== token) return null; // 0 filas
      if (row.processingUntil! <= clock.now) return null; // 55P03: reserva caducada
      const at = new Date(clock.now).toISOString();
      row.game = {
        ...row.game, state: structuredClone(state), version: version + 1, status: state.status, winner: state.winner,
        lastAction: structuredClone(action), lastEvents: structuredClone(events), updatedAt: at,
        finishedAt: state.status === "finished" ? at : null,
      };
      row.lockToken = null;
      row.processingUntil = null;
      return snapshot(row);
    },

    async release(id, token) {
      calls.release++;
      await tick();
      const row = rows.get(id);
      if (row && row.lockToken === token) {
        row.lockToken = null;
        row.processingUntil = null;
      }
    },
  };

  return { repository, rows, calls, clock };
}
