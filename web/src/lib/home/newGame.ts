// "Nueva partida" en la portada (sin React; fetch y navegación inyectados).
// Crea una partida real con POST /api/games y, si va bien, navega a /partida/[id]. Una sola
// petición a la vez: mientras se crea (y mientras se navega) los clics se ignoran.

import { z } from "zod";
import { retryAfterMs } from "@/lib/game/live";

export type CreateGameOutcome =
  | { kind: "created"; id: string }
  | { kind: "error"; message: string };

const CreatedSchema = z.object({ id: z.uuid(), version: z.number().int().min(1) });

/** Traduce la respuesta de POST /api/games a una partida creada o a un mensaje comprensible. */
export function interpretCreateResponse(status: number, body: unknown, retryAfter?: string | null): CreateGameOutcome {
  if (status === 201) {
    const parsed = CreatedSchema.safeParse(body);
    return parsed.success
      ? { kind: "created", id: parsed.data.id }
      : { kind: "error", message: "El servidor ha respondido de forma inesperada. Inténtalo de nuevo." };
  }
  if (status === 429) {
    const ms = retryAfterMs(retryAfter);
    const wait = ms === null ? "unos minutos" : ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`;
    return { kind: "error", message: `Se han creado muchas partidas seguidas. Espera ${wait} y vuelve a intentarlo.` };
  }
  if (status === 503) {
    return { kind: "error", message: "El servicio de partidas no está disponible ahora mismo. Inténtalo en unos segundos." };
  }
  return { kind: "error", message: "No se ha podido crear la partida. Inténtalo de nuevo." };
}

export type NewGameState =
  | { kind: "idle" }
  /** Creando la partida (o ya navegando a ella): el botón está desactivado. */
  | { kind: "creating" }
  | { kind: "error"; message: string };

export interface NewGameDeps {
  fetch: typeof fetch;
  /** Navega a la partida (en la app, `router.push`). */
  navigate: (href: string) => void;
}

export class NewGameController {
  private state: NewGameState = { kind: "idle" };
  private listeners = new Set<() => void>();
  /** Cambia con cada `reset()`: el resultado de una creación anterior se ignora (no navega). */
  private generation = 0;

  constructor(private readonly deps: NewGameDeps) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  /** Crea la partida y navega a ella. Si ya hay una creación en curso, no hace nada. */
  async create(): Promise<void> {
    if (this.state.kind === "creating") return;
    const generation = this.generation;
    this.set({ kind: "creating" });
    let outcome: CreateGameOutcome;
    try {
      const response = await this.deps.fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      outcome = interpretCreateResponse(response.status, await response.json().catch(() => null), response.headers.get("Retry-After"));
    } catch {
      outcome = { kind: "error", message: "No hay conexión con el servidor. Comprueba la red e inténtalo de nuevo." };
    }
    if (generation !== this.generation) return; // se salió de la portada mientras se creaba
    if (outcome.kind === "error") {
      this.set({ kind: "error", message: outcome.message });
      return;
    }
    // Se queda en "creating" mientras se navega: un segundo clic no crea otra partida.
    this.deps.navigate(`/partida/${outcome.id}`);
  }

  /**
   * Vuelve al estado inicial. Lo llama el botón cuando la portada deja de verse: con
   * `cacheComponents`, Next.js no la desmonta al navegar (la oculta con <Activity> y conserva el
   * estado), así que sin esto, al volver, el botón seguía en "creating" y no respondía.
   */
  reset() {
    this.generation++;
    if (this.state.kind !== "idle") this.set({ kind: "idle" });
  }

  private set(state: NewGameState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
