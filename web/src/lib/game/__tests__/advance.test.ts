import { describe, expect, it } from "vitest";
import { applyAction, createGame, type GameState } from "@/lib/engine";
import { advanceGame, type AdvanceDeps } from "../advance";
import { CHARACTER_IDS } from "../characters";
import { LEASE_MS, createMemoryRepository } from "./memoryRepository";

let tokens = 0;
function deps(repository: AdvanceDeps["repository"], dice: number[] | (() => number) = [5]): AdvanceDeps {
  const queue = Array.isArray(dice) ? [...dice] : null;
  return {
    repository,
    rollDie: queue ? () => queue.shift() ?? 1 : (dice as () => number),
    newToken: () => `token-${++tokens}`,
  };
}

async function newGame(state: GameState = createGame([...CHARACTER_IDS])) {
  const memory = createMemoryRepository();
  const game = await memory.repository.create(state);
  return { ...memory, id: game.id };
}

describe("advanceGame: casos normales", () => {
  it("v1 → v2: tira el dado del servidor y guarda acción y eventos", async () => {
    const { repository, id } = await newGame();
    const result = await advanceGame(id, 1, deps(repository, [5]));
    expect(result.kind).toBe("advanced");
    if (result.kind !== "advanced") return;
    expect(result.action).toEqual({ type: "roll", playerId: "ai-pink", value: 5 });
    expect(result.events).toEqual([{ type: "dice_rolled", playerId: "ai-pink", value: 5 }]);
    expect(result.game).toMatchObject({ version: 2, lastAction: result.action, lastEvents: result.events, processingUntil: null });
    expect(result.game.state.dice).toBe(5);
  });

  it("v2 → v3: con dado, la IA mueve una ficha legal", async () => {
    const { repository, id } = await newGame();
    await advanceGame(id, 1, deps(repository, [5]));
    const result = await advanceGame(id, 2, deps(repository, []));
    expect(result).toMatchObject({ kind: "advanced", action: { type: "move", playerId: "ai-pink" } });
    if (result.kind !== "advanced") return;
    expect(result.game.version).toBe(3);
    expect(result.game.state.turn).toBe("ai-blue"); // un 5 no repite: pasa el turno
  });

  it("sin movimientos legales: la tirada se aplica y el turno pasa (una sola versión)", async () => {
    const { repository, id } = await newGame();
    const result = await advanceGame(id, 1, deps(repository, [3])); // todas en casa con un 3
    expect(result).toMatchObject({ kind: "advanced", game: { version: 2 } });
    if (result.kind !== "advanced") return;
    expect(result.events.map((e) => e.type)).toEqual(["dice_rolled", "no_moves", "turn_changed"]);
    expect(result.game.state).toMatchObject({ turn: "ai-blue", dice: null });
  });

  it("respeta el tercer seis: penalización y pérdida de turno", async () => {
    const state = createGame([...CHARACTER_IDS]);
    state.sixesInTurn = 2; // dos seises ya en este turno
    const { repository, id } = await newGame(state);
    const result = await advanceGame(id, 1, deps(repository, [6]));
    if (result.kind !== "advanced") throw new Error(result.kind);
    expect(result.events.map((e) => e.type)).toEqual(["dice_rolled", "third_six_penalty", "turn_changed"]);
    expect(result.game.state.turn).toBe("ai-blue");
  });

  it("partida completa con avances sucesivos: versiones de 1 en 1, jugadas legales y ganador", async () => {
    const { repository, id } = await newGame();
    let seed = 5;
    const die = () => 1 + Math.floor((((seed = (seed * 16807) % 2147483647) - 1) / 2147483646) * 6);
    let version = 1;
    let previous = (await repository.get(id))!.state;
    for (;;) {
      const result = await advanceGame(id, version, deps(repository, die));
      if (result.kind === "game_finished") break;
      expect(result.kind).toBe("advanced");
      if (result.kind !== "advanced") return;
      // Lo guardado es exactamente lo que da el motor al aplicar la acción sobre el estado anterior.
      const replay = applyAction(previous, result.action);
      expect(replay.ok && replay.state).toEqual(result.game.state);
      expect(result.game.version).toBe(++version);
      previous = result.game.state;
      if (version > 20_000) throw new Error("la partida no termina");
    }
    const final = (await repository.get(id))!;
    expect(final.status).toBe("finished");
    expect(final.state.ranking).toHaveLength(4);
    expect(final.winner).toBe(final.state.ranking[0]);
  });
});

describe("advanceGame: errores y partidas finalizadas", () => {
  it("partida inexistente", async () => {
    const { repository } = await newGame();
    expect(await advanceGame("00000000-0000-4000-8000-999999999999", 1, deps(repository))).toEqual({ kind: "not_found" });
  });

  it("partida finalizada: no se reserva ni se modifica", async () => {
    const finished = { ...createGame([...CHARACTER_IDS]), status: "finished" as const, winner: "ai-green", ranking: ["ai-green"] };
    const { repository, id, calls, rows } = await newGame(finished);
    expect(await advanceGame(id, 1, deps(repository))).toEqual({ kind: "game_finished", version: 1 });
    expect(calls.claim).toBe(0);
    expect(rows.get(id)!.game.version).toBe(1);
  });

  it("si el motor o la IA fallan tras reservar, se libera la reserva y no se guarda nada", async () => {
    const { repository, id, rows, calls } = await newGame();
    const failing = deps(repository, () => {
      throw new Error("fallo del generador");
    });
    await expect(advanceGame(id, 1, failing)).rejects.toThrow("fallo del generador");
    expect(calls.release).toBe(1);
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 1 } });
  });

  it("reserva caducada antes de confirmar: lease_expired y nada guardado", async () => {
    const { repository, id, rows, clock } = await newGame();
    const slow = deps(repository, () => {
      clock.now += LEASE_MS + 1; // la "IA" tarda más que la reserva
      return 4;
    });
    expect(await advanceGame(id, 1, slow)).toEqual({ kind: "lease_expired" });
    expect(rows.get(id)).toMatchObject({ lockToken: null, game: { version: 1, lastAction: null } });
  });
});

describe("advanceGame: concurrencia y reintentos", () => {
  it("reintento con la misma versión tras un éxito: version_conflict, sin repetir el movimiento", async () => {
    const { repository, id, rows } = await newGame();
    expect((await advanceGame(id, 1, deps(repository, [5]))).kind).toBe("advanced");
    const before = structuredClone(rows.get(id)!.game);
    expect(await advanceGame(id, 1, deps(repository, [5]))).toEqual({ kind: "version_conflict", currentVersion: 2 });
    expect(rows.get(id)!.game).toEqual(before);
  });

  it("dos peticiones simultáneas con la misma versión: solo una avanza", async () => {
    const { repository, id, rows } = await newGame();
    const results = await Promise.all([advanceGame(id, 1, deps(repository, [5])), advanceGame(id, 1, deps(repository, [2]))]);
    const kinds = results.map((r) => r.kind).sort();
    // La otra ve la reserva vigente (turn_in_progress) o, si la primera ya confirmó, la nueva versión.
    expect(kinds[0]).toBe("advanced");
    expect(["turn_in_progress", "version_conflict"]).toContain(kinds[1]);
    expect(rows.get(id)!.game.version).toBe(2);
    expect(rows.get(id)!.lockToken).toBeNull();
  });

  it("diez peticiones simultáneas: exactamente una avanza y la versión sube solo 1", async () => {
    const { repository, id, rows } = await newGame();
    const results = await Promise.all(Array.from({ length: 10 }, () => advanceGame(id, 1, deps(repository, [4]))));
    expect(results.filter((r) => r.kind === "advanced")).toHaveLength(1);
    expect(results.every((r) => ["advanced", "turn_in_progress", "version_conflict"].includes(r.kind))).toBe(true);
    expect(rows.get(id)!.game.version).toBe(2);
    expect(rows.get(id)!.game.lastEvents).toEqual([
      { type: "dice_rolled", playerId: "ai-pink", value: 4 },
      { type: "no_moves", playerId: "ai-pink", value: 4 },
      { type: "turn_changed", playerId: "ai-blue" },
    ]);
  });

  it("con una reserva vigente de otro proceso: turn_in_progress; cuando caduca, se puede avanzar", async () => {
    const { repository, id, clock } = await newGame();
    await repository.claim(id, 1, "otro-proceso");
    expect(await advanceGame(id, 1, deps(repository))).toEqual({ kind: "turn_in_progress" });
    clock.now += LEASE_MS; // caduca
    expect((await advanceGame(id, 1, deps(repository, [6]))).kind).toBe("advanced");
    // El proceso antiguo ya no puede confirmar su resultado.
    expect(await repository.commit(id, 1, "otro-proceso", { state: createGame([...CHARACTER_IDS]), action: { type: "timeout" }, events: [] })).toBeNull();
  });
});
