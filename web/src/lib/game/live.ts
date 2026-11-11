// Modelo puro de una partida en directo en el navegador (sin React, sin red).
// - `latest`: la versión más alta conocida (de Realtime, de la respuesta de advance o de un GET).
// - `display`: la versión que se está mostrando (destino de la animación en curso).
// - `queue`: versiones pendientes de mostrar, en orden, entre `display` y `latest`.
// Las versiones ≤ `latest` se ignoran (duplicados, reservas/liberaciones con la misma versión).

import { z } from "zod";
import { GameResponseSchema, toGameResponse, type GameResponse } from "./api";
import { ENGINE_STATE_VERSION, GameActionSchema, GameEventSchema, GameRowSchema, GameStateSchema, toStoredGame } from "./schemas";

/** Más versiones pendientes que esto → se salta a la última sin animar las intermedias. */
export const MAX_QUEUE = 3;

export interface LiveModel {
  latest: GameResponse;
  display: GameResponse;
  queue: GameResponse[];
}

export const initLive = (initial: GameResponse): LiveModel => ({ latest: initial, display: initial, queue: [] });

/** Incorpora una versión recibida. Las anteriores o iguales a `latest` no cambian el juego. */
export function receive(model: LiveModel, incoming: GameResponse): LiveModel {
  if (incoming.id !== model.latest.id) return model;

  if (incoming.version === model.latest.version) {
    // Misma versión: el juego no cambia; solo se refrescan fechas si son más recientes (la respuesta
    // de advance no trae fechas y reutiliza las anteriores: nunca deben pisar las de Realtime/GET).
    const newer = Date.parse(incoming.updatedAt) > Date.parse(model.latest.updatedAt);
    const finishing = incoming.finishedAt !== null && model.latest.finishedAt === null;
    if (!newer && !finishing) return model;
    const patch = {
      updatedAt: newer ? incoming.updatedAt : model.latest.updatedAt,
      finishedAt: model.latest.finishedAt ?? incoming.finishedAt,
    };
    const refresh = (g: GameResponse) => (g.version === incoming.version ? { ...g, ...patch } : g);
    return { latest: refresh(model.latest), display: refresh(model.display), queue: model.queue.map(refresh) };
  }
  if (incoming.version < model.latest.version) return model;

  return { ...model, latest: incoming, queue: [...model.queue, incoming] };
}

export type DisplayStep =
  /** Versión siguiente: se anima con sus eventos. */
  | { kind: "animate"; from: GameResponse; to: GameResponse }
  /** Hueco de versiones (o cola larga): se muestra directamente, sin animar. */
  | { kind: "jump"; to: GameResponse };

/** Siguiente paso a mostrar, o `null` si `display` ya es la última versión. */
export function takeDisplayStep(model: LiveModel): { model: LiveModel; step: DisplayStep } | null {
  if (model.queue.length === 0) return null;
  if (model.queue.length > MAX_QUEUE) {
    return { model: { ...model, display: model.latest, queue: [] }, step: { kind: "jump", to: model.latest } };
  }
  const [next, ...rest] = model.queue;
  const step: DisplayStep =
    next.version === model.display.version + 1 ? { kind: "animate", from: model.display, to: next } : { kind: "jump", to: next };
  return { model: { ...model, display: next, queue: rest }, step };
}

/** Se puede pedir el siguiente avance: todo mostrado y la partida sigue en juego. */
export const isCaughtUp = (model: LiveModel) => model.queue.length === 0 && model.display.version === model.latest.version;

// ─── Datos recibidos ────────────────────────────────────────────────────────

/** Fila de `public.games` recibida por Realtime → contrato de lectura, o `null` si no es válida. */
export function parseRealtimeRow(row: unknown): GameResponse | null {
  const parsed = GameRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.engine_version !== ENGINE_STATE_VERSION) return null;
  return toGameResponse(toStoredGame(parsed.data));
}

/** Respuesta 200 de POST /api/games/[id]/advance. */
const AdvanceResponseSchema = z.object({
  id: z.uuid(),
  version: z.number().int().min(1),
  status: z.enum(["playing", "finished"]),
  winner: z.string().min(1).nullable(),
  action: GameActionSchema,
  events: z.array(GameEventSchema),
  state: GameStateSchema,
});

export type AdvanceOutcome =
  /** Nueva versión (200). */
  | { kind: "update"; game: GameResponse }
  /**
   * La partida avanzó o terminó por otro lado (409 version_conflict / game_finished): ponerse al día.
   * `currentVersion` (si el servidor la da) permite saltarse el GET si Realtime ya la entregó.
   */
  | { kind: "resync"; currentVersion?: number }
  /** Otro proceso tiene el turno o la reserva caducó: esperar y volver a intentar con la misma versión. */
  | { kind: "wait" }
  /**
   * Fallo transitorio (red, 503, 500, respuesta no válida): reintentar con espera creciente.
   * Con 429, `delayMs` es la espera que indica el servidor (Retry-After).
   */
  | { kind: "retry"; message: string; delayMs?: number }
  /** No tiene sentido seguir (404, 400). */
  | { kind: "fatal"; message: string };

/**
 * Interpreta la respuesta de advance. `current` aporta las fechas que la respuesta no trae.
 * `retryAfter`: valor de la cabecera Retry-After (segundos), si la hay.
 */
export function interpretAdvance(status: number, body: unknown, current: GameResponse, retryAfter?: string | null): AdvanceOutcome {
  if (status === 200) {
    const parsed = AdvanceResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== current.id) return { kind: "retry", message: "Respuesta no válida del servidor." };
    const { id, version, status: gameStatus, winner, action, events, state } = parsed.data;
    const game = GameResponseSchema.safeParse({
      ...current,
      id, version, status: gameStatus, winner, state, lastAction: action, lastEvents: events,
    });
    return game.success ? { kind: "update", game: game.data } : { kind: "retry", message: "Respuesta no válida del servidor." };
  }

  const { error, currentVersion } = (body ?? {}) as { error?: { code?: unknown }; currentVersion?: unknown };
  const code = error?.code;
  if (status === 409) {
    if (code === "version_conflict" || code === "game_finished") {
      return Number.isInteger(currentVersion) ? { kind: "resync", currentVersion: currentVersion as number } : { kind: "resync" };
    }
    return { kind: "wait" }; // turn_in_progress, lease_expired
  }
  if (status === 429) {
    return { kind: "retry", message: "Demasiadas peticiones; esperando…", delayMs: retryAfterMs(retryAfter) ?? 5000 };
  }
  if (status === 404) return { kind: "fatal", message: "La partida ya no existe." };
  if (status === 400) return { kind: "fatal", message: "Petición de avance no válida." };
  if (status === 503) return { kind: "retry", message: "El almacenamiento de partidas no responde." };
  return { kind: "retry", message: "Error del servidor al avanzar la partida." };
}

/** Retry-After en segundos (1..300) → milisegundos; `null` si falta o no es válido. */
export function retryAfterMs(value: string | null | undefined): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 300 ? seconds * 1000 : null;
}

/** Espera antes del reintento nº `failures` (1, 2, 4, 8… s, máximo 15 s). */
export const retryDelay = (failures: number) => Math.min(1000 * 2 ** Math.max(0, failures - 1), 15_000);
