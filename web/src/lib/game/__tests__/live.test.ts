import { describe, expect, it } from "vitest";
import { applyAction, createGame, type GameState } from "@/lib/engine";
import type { GameResponse } from "../api";
import { CHARACTER_IDS } from "../characters";
import { MAX_QUEUE, initLive, interpretAdvance, isCaughtUp, parseRealtimeRow, receive, retryDelay, takeDisplayStep } from "../live";

const ID = "3f39156e-12ec-4bd0-86af-58a5ccf8cd66";

/** Versiones consecutivas reales (tiradas de 3: sin movimientos, el turno pasa). */
function versions(count: number): GameResponse[] {
  let state: GameState = createGame([...CHARACTER_IDS]);
  const out: GameResponse[] = [];
  for (let v = 1; v <= count; v++) {
    let lastAction = null, lastEvents: GameResponse["lastEvents"] = [];
    if (v > 1) {
      const action = { type: "roll" as const, playerId: state.turn, value: 3 };
      const result = applyAction(state, action);
      if (!result.ok) throw new Error(result.error);
      state = result.state; lastAction = action; lastEvents = result.events;
    }
    out.push({
      id: ID, version: v, status: state.status, winner: state.winner, state, lastAction, lastEvents,
      createdAt: "2026-11-11T10:00:00+00:00", updatedAt: `2026-11-11T10:00:${String(v).padStart(2, "0")}+00:00`, finishedAt: null,
    });
  }
  return out;
}

describe("modelo en directo: recibir versiones", () => {
  const [v1, v2, v3] = versions(3);

  it("una versión nueva se encola; las anteriores o de otra partida se ignoran", () => {
    let model = receive(initLive(v1), v2);
    expect(model.latest.version).toBe(2);
    expect(model.queue.map((g) => g.version)).toEqual([2]);
    expect(receive(model, v1)).toBe(model); // antigua
    expect(receive(model, { ...v3, id: "00000000-0000-4000-8000-000000000000" })).toBe(model); // otra partida
    model = receive(model, v3);
    expect(model.queue.map((g) => g.version)).toEqual([2, 3]);
  });

  it("misma versión: no se encola dos veces; solo refresca fechas más recientes o finished_at", () => {
    const model = receive(initLive(v1), v2);
    expect(receive(model, v2)).toBe(model); // duplicado exacto (Realtime + respuesta de advance)
    const stale = receive(model, { ...v2, updatedAt: v1.updatedAt }); // advance reutiliza fechas antiguas
    expect(stale).toBe(model);
    const fresher = receive(model, { ...v2, updatedAt: "2026-11-11T10:05:00+00:00" });
    expect(fresher.latest.updatedAt).toBe("2026-11-11T10:05:00+00:00");
    expect(fresher.queue).toHaveLength(1);
    expect(receive(model, { ...v2, finishedAt: "2026-11-11T10:06:00+00:00" }).latest.finishedAt).toBe("2026-11-11T10:06:00+00:00");
  });
});

describe("modelo en directo: qué mostrar", () => {
  const all = versions(7);

  it("la versión siguiente se anima; un hueco de versiones salta sin animar", () => {
    let model = receive(receive(initLive(all[0]), all[1]), all[3]); // llegan v2 y v4 (falta v3)
    let next = takeDisplayStep(model)!;
    expect(next.step).toMatchObject({ kind: "animate", from: { version: 1 }, to: { version: 2 } });
    model = next.model;
    next = takeDisplayStep(model)!;
    expect(next.step).toMatchObject({ kind: "jump", to: { version: 4 } });
    expect(isCaughtUp(next.model)).toBe(true);
    expect(takeDisplayStep(next.model)).toBeNull();
  });

  it(`con más de ${MAX_QUEUE} versiones pendientes se salta directamente a la última`, () => {
    let model = initLive(all[0]);
    for (const g of all.slice(1, 2 + MAX_QUEUE)) model = receive(model, g);
    const next = takeDisplayStep(model)!;
    expect(next.step).toEqual({ kind: "jump", to: model.latest });
    expect(isCaughtUp(next.model)).toBe(true);
  });
});

describe("datos recibidos", () => {
  const [v1, v2] = versions(2);
  const row = (g: GameResponse, extra: Record<string, unknown> = {}) => ({
    id: g.id, state: g.state, engine_version: 1, status: g.status, winner: g.winner, version: g.version,
    lock_token: null, processing_until: null, last_action: g.lastAction, last_events: g.lastEvents,
    created_at: g.createdAt, updated_at: g.updatedAt, finished_at: g.finishedAt, ...extra,
  });

  it("fila de Realtime válida → contrato de lectura (sin datos internos); inválida → null", () => {
    expect(parseRealtimeRow(row(v2))).toEqual(v2);
    expect(parseRealtimeRow(row(v2, { lock_token: "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f", processing_until: "2026-11-11T10:00:20+00:00" }))).toEqual(v2);
    expect(parseRealtimeRow(row(v2, { engine_version: 2 }))).toBeNull();
    expect(parseRealtimeRow(row(v2, { status: "finished" }))).toBeNull();
    expect(parseRealtimeRow({ id: ID })).toBeNull();
  });

  it("respuesta de advance: 200 → nueva versión con las fechas conocidas; resto de códigos", () => {
    const body = { id: ID, version: 2, status: "playing", winner: null, action: v2.lastAction, events: v2.lastEvents, state: v2.state };
    expect(interpretAdvance(200, body, v1)).toEqual({ kind: "update", game: { ...v2, updatedAt: v1.updatedAt } });
    expect(interpretAdvance(200, { ...body, id: "00000000-0000-4000-8000-000000000000" }, v1).kind).toBe("retry");
    expect(interpretAdvance(200, { nada: 1 }, v1).kind).toBe("retry");
    expect(interpretAdvance(409, { error: { code: "version_conflict" }, currentVersion: 5 }, v1)).toEqual({ kind: "resync", currentVersion: 5 });
    expect(interpretAdvance(409, { error: { code: "game_finished" }, currentVersion: 640 }, v1)).toEqual({ kind: "resync", currentVersion: 640 });
    expect(interpretAdvance(409, { error: { code: "version_conflict" } }, v1)).toEqual({ kind: "resync" });
    expect(interpretAdvance(409, { error: { code: "turn_in_progress" } }, v1)).toEqual({ kind: "wait" });
    expect(interpretAdvance(409, { error: { code: "lease_expired" } }, v1)).toEqual({ kind: "wait" });
    expect(interpretAdvance(429, { error: { code: "rate_limited" } }, v1, "7")).toEqual({ kind: "retry", message: "Demasiadas peticiones; esperando…", delayMs: 7000 });
    expect(interpretAdvance(429, null, v1, null)).toMatchObject({ kind: "retry", delayMs: 5000 }); // sin Retry-After
    expect(interpretAdvance(429, null, v1, "99999")).toMatchObject({ delayMs: 5000 }); // valor absurdo: se ignora
    expect(interpretAdvance(404, null, v1).kind).toBe("fatal");
    expect(interpretAdvance(400, null, v1).kind).toBe("fatal");
    expect(interpretAdvance(503, null, v1).kind).toBe("retry");
    expect(interpretAdvance(500, null, v1).kind).toBe("retry");
  });

  it("espera creciente entre reintentos (máx. 15 s)", () => {
    expect([1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});
