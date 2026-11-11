import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@/lib/engine";
import { CHARACTER_IDS } from "../characters";
import type { GamesRepository } from "../repository";
import type { StoredGame } from "../schemas";

vi.mock("server-only", () => ({}));

const { loadGame } = await import("../load");
const { GameRepositoryError } = await import("../repository");
const { SupabaseEnvError } = await import("@/lib/supabase/env");

const ID = "3f39156e-12ec-4bd0-86af-58a5ccf8cd66";
const stored: StoredGame = {
  id: ID,
  state: createGame([...CHARACTER_IDS]),
  version: 7,
  engineVersion: 1,
  status: "playing",
  winner: null,
  lastAction: { type: "move", playerId: "ai-pink", pieceIndex: 0 },
  lastEvents: [{ type: "turn_changed", playerId: "ai-blue" }],
  processingUntil: "2026-11-11T00:00:20+00:00",
  createdAt: "2026-11-11T00:00:00+00:00",
  updatedAt: "2026-11-11T00:00:05+00:00",
  finishedAt: null,
};

const repo = (get: GamesRepository["get"]) => ({ get }) as unknown as GamesRepository;

describe("loadGame (servidor)", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("ok: devuelve el contrato validado (con última acción y eventos, sin datos internos)", async () => {
    const result = await loadGame(ID, repo(async () => stored));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.game).toMatchObject({ id: ID, version: 7, lastAction: stored.lastAction, lastEvents: stored.lastEvents });
    expect(result.game).not.toHaveProperty("processingUntil");
    expect(result.game).not.toHaveProperty("engineVersion");
  });

  it("not_found si el repositorio no la encuentra (también ids no válidos)", async () => {
    const get = vi.fn(async () => null);
    expect(await loadGame("no-es-uuid", repo(get))).toEqual({ kind: "not_found" });
    expect(get).toHaveBeenCalledWith("no-es-uuid");
  });

  it("errores → mensaje seguro para el usuario, sin lanzar ni exponer detalles", async () => {
    const cases: [unknown, string][] = [
      [new GameRepositoryError("database", "Fallo de red al leer la partida: fetch failed"), "El almacenamiento de partidas no está disponible ahora mismo."],
      [new GameRepositoryError("invalid_data", "Partida guardada no válida: state.turn"), "La partida guardada no se puede leer."],
      [new GameRepositoryError("unsupported_version", "Formato 2 no soportado"), "La partida guardada no se puede leer."],
      [new SupabaseEnvError("SUPABASE_SECRET_KEY: falta"), "El servidor no está configurado correctamente."],
      [new Error("boom"), "No se ha podido recuperar la partida."],
    ];
    for (const [error, message] of cases) {
      const result = await loadGame(ID, repo(async () => Promise.reject(error)));
      expect(result).toEqual({ kind: "error", message });
    }
  });

  it("si el repositorio devolviera un estado que no cumple el contrato, es un error (no se muestra)", async () => {
    const broken = { ...stored, status: "finished" as const }; // no coincide con state.status
    expect(await loadGame(ID, repo(async () => broken))).toMatchObject({ kind: "error" });
  });
});
