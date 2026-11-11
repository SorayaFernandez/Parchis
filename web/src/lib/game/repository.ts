// Repositorio de partidas: único punto de lectura/escritura de `public.games`.
// Usa exclusivamente el cliente de servidor (clave secreta). No debe importarse desde el navegador.

import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { GameAction, GameEvent, GameState } from "@/lib/engine";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ENGINE_STATE_VERSION,
  GameActionSchema,
  GameEventSchema,
  GameRowSchema,
  GameStateSchema,
  toStoredGame,
  type StoredGame,
} from "./schemas";

const TABLE = "games";

export type GameRepositoryErrorKind =
  /** No existe una partida con ese id (o el id no es válido). */
  | "not_found"
  /** Los datos guardados o a guardar no superan la validación. */
  | "invalid_data"
  /** La partida usa un formato de estado distinto del actual. */
  | "unsupported_version"
  /** Fallo de Supabase (red, permisos, restricciones…). */
  | "database";

export class GameRepositoryError extends Error {
  override name = "GameRepositoryError";
  constructor(
    readonly kind: GameRepositoryErrorKind,
    message: string,
    /** Código de PostgreSQL/PostgREST, si lo hay (p. ej. "55P03", "42501"). Solo para registros. */
    readonly code?: string,
  ) {
    super(message);
  }
}

function databaseError(action: string, error: PostgrestError): GameRepositoryError {
  // Sin código de PostgreSQL, la petición no obtuvo respuesta (red, tiempo de espera…): el mensaje
  // técnico ("fetch failed"…) no contiene datos ni claves y ayuda a diagnosticar. La operación pudo
  // aplicarse en la BD aunque la respuesta se perdiera; la versión evita duplicarla al reintentar.
  if (!error.code) {
    return new GameRepositoryError("database", `Fallo de red al ${action}: ${String(error.message).slice(0, 120)}`);
  }
  return new GameRepositoryError("database", `Error de base de datos al ${action}`, error.code);
}

/** Valida una fila recibida y la convierte al formato de la aplicación. */
export function parseGameRow(data: unknown): StoredGame {
  const result = GameRowSchema.safeParse(data);
  if (!result.success) {
    throw new GameRepositoryError("invalid_data", `Partida guardada no válida: ${z.prettifyError(result.error)}`);
  }
  if (result.data.engine_version !== ENGINE_STATE_VERSION) {
    throw new GameRepositoryError(
      "unsupported_version",
      `Formato de partida ${result.data.engine_version} no soportado (actual: ${ENGINE_STATE_VERSION})`,
    );
  }
  return toStoredGame(result.data);
}

/** Código de PostgreSQL que usa el trigger `games_guard` para conflictos de reserva/versión. */
const LOCK_NOT_AVAILABLE = "55P03";

/** Resultado de aplicar una acción, para confirmarlo en la BD. */
export interface CommitData {
  state: GameState;
  action: GameAction;
  events: GameEvent[];
}

export interface GamesRepository {
  /** Guarda una partida nueva (versión 1) y la devuelve tal como quedó en la BD. */
  create(state: GameState): Promise<StoredGame>;
  /** Lee una partida; `null` si no existe. */
  get(id: string): Promise<StoredGame | null>;
  /**
   * Reserva el turno de la versión `version` con `token` (plazo de 20 s, fijado por la BD).
   * `null` si no se puede: la versión cambió, la partida terminó o hay otra reserva vigente.
   */
  claim(id: string, version: number, token: string): Promise<StoredGame | null>;
  /**
   * Confirma una acción: guarda el nuevo estado como `version + 1` y libera la reserva.
   * `null` si no se puede: la versión cambió, el token no es el de la reserva o esta caducó
   * (en ese caso no se guarda nada).
   */
  commit(id: string, version: number, token: string, data: CommitData): Promise<StoredGame | null>;
  /** Libera la reserva de `token` si sigue siendo suya (no hace nada en otro caso). */
  release(id: string, token: string): Promise<void>;
}

/** Repositorio sobre un cliente concreto (permite inyectar otro en pruebas). */
export function createGamesRepository(client: SupabaseClient): GamesRepository {
  return {
    async create(state) {
      // Se valida antes de escribir: a la BD solo llegan estados correctos.
      const checked = GameStateSchema.safeParse(state);
      if (!checked.success) {
        throw new GameRepositoryError("invalid_data", `Estado inicial no válido: ${z.prettifyError(checked.error)}`);
      }

      const { data, error } = await client
        .from(TABLE)
        .insert({ state: checked.data, engine_version: ENGINE_STATE_VERSION })
        .select()
        .single();
      if (error) throw databaseError("crear la partida", error);
      return parseGameRow(data);
    },

    async get(id) {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await client.from(TABLE).select().eq("id", id).maybeSingle();
      if (error) throw databaseError("leer la partida", error);
      return data === null ? null : parseGameRow(data);
    },

    async claim(id, version, token) {
      // El plazo (processing_until) lo fija el trigger con el reloj de PostgreSQL.
      const { data, error } = await client
        .from(TABLE)
        .update({ lock_token: token })
        .eq("id", id)
        .eq("version", version)
        .eq("status", "playing")
        .select()
        .maybeSingle();
      if (error) {
        if (error.code === LOCK_NOT_AVAILABLE) return null; // reserva vigente de otro proceso
        throw databaseError("reservar el turno", error);
      }
      return data === null ? null : parseGameRow(data);
    },

    async commit(id, version, token, { state, action, events }) {
      // Se valida antes de escribir: a la BD solo llegan estados, acciones y eventos correctos.
      const checked = CommitSchema.safeParse({ state, action, events });
      if (!checked.success) {
        throw new GameRepositoryError("invalid_data", `Resultado no válido: ${z.prettifyError(checked.error)}`);
      }
      // WHERE con versión y token: solo quien tiene la reserva confirma. SET lock_token = token:
      // el trigger exige el mismo token y una reserva vigente, y la libera al confirmar.
      const { data, error } = await client
        .from(TABLE)
        .update({
          state: checked.data.state,
          version: version + 1,
          last_action: checked.data.action,
          last_events: checked.data.events,
          lock_token: token,
        })
        .eq("id", id)
        .eq("version", version)
        .eq("lock_token", token)
        .select()
        .maybeSingle();
      if (error) {
        if (error.code === LOCK_NOT_AVAILABLE) return null; // reserva caducada
        throw databaseError("guardar la acción", error);
      }
      return data === null ? null : parseGameRow(data);
    },

    async release(id, token) {
      const { error } = await client.from(TABLE).update({ lock_token: null }).eq("id", id).eq("lock_token", token);
      if (error) throw databaseError("liberar la reserva", error);
    },
  };
}

const CommitSchema = z.object({
  state: GameStateSchema,
  action: GameActionSchema,
  events: z.array(GameEventSchema),
});

/** Repositorio con el cliente de servidor de la aplicación. */
export function getGamesRepository(): GamesRepository {
  return createGamesRepository(getServerSupabase());
}
