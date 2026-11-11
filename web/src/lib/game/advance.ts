// Avance de una partida: aplica UNA acción (tirar o mover) del jugador en turno.
// Protocolo (ver SQL de `public.games` y su trigger `games_guard`):
//   1. Leer la partida y comprobar la versión esperada y que sigue en juego.
//   2. Reservar el turno (lock_token; plazo de 20 s fijado por PostgreSQL).
//   3. Decidir la acción (dado del servidor + IA) y aplicarla con el motor.
//   4. Confirmar como versión + 1 con el mismo token (libera la reserva).
//   Si algo falla tras reservar, se libera la reserva.
// Un reintento o una petición duplicada con la misma `expectedVersion` nunca repite un movimiento:
// la versión ya habrá cambiado (version_conflict) o la reserva estará tomada (turn_in_progress).

import { applyAction, type GameAction, type GameEvent } from "@/lib/engine";
import { decideAction, type RandomSource } from "./ai";
import type { GamesRepository } from "./repository";
import type { StoredGame } from "./schemas";

export type AdvanceResult =
  | { kind: "advanced"; game: StoredGame; action: GameAction; events: GameEvent[] }
  | { kind: "not_found" }
  | { kind: "game_finished"; version: number }
  /** La partida no está en la versión esperada (otra petición avanzó antes o es un reintento). */
  | { kind: "version_conflict"; currentVersion: number }
  /** Otra petición tiene reservado el turno ahora mismo. */
  | { kind: "turn_in_progress" }
  /** La reserva caducó antes de confirmar: no se ha guardado nada. */
  | { kind: "lease_expired" };

export interface AdvanceDeps {
  repository: GamesRepository;
  /** Valor del dado (1–6). En el servidor: crypto.randomInt(1, 7). */
  rollDie: () => number;
  /** Token único para la reserva. En el servidor: crypto.randomUUID(). */
  newToken: () => string;
  /**
   * Azar en [0, 1) para los personajes con azar acotado (Chispa). En el servidor: crypto.
   * Sin él, todos eligen siempre su mejor jugada (determinista).
   */
  random?: RandomSource;
}

/** Error del motor al aplicar la acción elegida (no debería ocurrir: la IA solo elige jugadas legales). */
export class EngineRejectedActionError extends Error {
  override name = "EngineRejectedActionError";
}

export async function advanceGame(id: string, expectedVersion: number, deps: AdvanceDeps): Promise<AdvanceResult> {
  const { repository, rollDie, newToken, random } = deps;

  // 1. Comprobaciones previas (evitan reservar en vano y dan respuestas precisas).
  const current = await repository.get(id);
  if (!current) return { kind: "not_found" };
  if (current.version !== expectedVersion) return { kind: "version_conflict", currentVersion: current.version };
  if (current.status === "finished") return { kind: "game_finished", version: current.version };

  // 2. Reservar. Si falla, se averigua el motivo con una lectura nueva.
  const token = newToken();
  const claimed = await repository.claim(id, expectedVersion, token);
  if (!claimed) {
    const now = await repository.get(id);
    if (!now) return { kind: "not_found" };
    if (now.version !== expectedVersion) return { kind: "version_conflict", currentVersion: now.version };
    if (now.status === "finished") return { kind: "game_finished", version: now.version };
    return { kind: "turn_in_progress" };
  }

  try {
    // 3. Decidir y aplicar con el motor sobre el estado reservado (el de la BD en esa versión).
    const action = decideAction(claimed.state, rollDie, random);
    const result = applyAction(claimed.state, action);
    if (!result.ok) throw new EngineRejectedActionError(`El motor rechazó ${action.type}: ${result.error}`);

    // 4. Confirmar como versión + 1. Si la reserva caducó, la BD lo rechaza y no se guarda nada.
    const saved = await repository.commit(id, expectedVersion, token, {
      state: result.state,
      action,
      events: result.events,
    });
    if (!saved) {
      await releaseQuietly(repository, id, token);
      return { kind: "lease_expired" };
    }
    return { kind: "advanced", game: saved, action, events: result.events };
  } catch (error) {
    await releaseQuietly(repository, id, token);
    throw error;
  }
}

/** Libera la reserva sin ocultar el error original si la liberación también falla (caducará sola). */
async function releaseQuietly(repository: GamesRepository, id: string, token: string): Promise<void> {
  try {
    await repository.release(id, token);
  } catch {
    // La reserva caduca sola a los 20 s.
  }
}
