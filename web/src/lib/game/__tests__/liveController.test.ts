// Controlador en directo contra un "mundo" falso: servidor con el advanceGame real sobre el
// repositorio en memoria (reproduce el trigger), Realtime que difunde cada cambio y reloj falso.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@/lib/engine";
import { advanceGame } from "../advance";
import { toGameResponse, type GameResponse } from "../api";
import { CHARACTER_IDS } from "../characters";
import { LiveGameController, type RealtimeHandlers, type RealtimeStatus } from "../liveController";
import type { StoredGame } from "../schemas";
import { createMemoryRepository } from "./memoryRepository";

function toRow(game: StoredGame, lockToken: string | null = null) {
  return {
    id: game.id, state: game.state, engine_version: 1, status: game.status, winner: game.winner, version: game.version,
    lock_token: lockToken, processing_until: lockToken ? "2026-11-11T10:00:20+00:00" : null,
    last_action: game.lastAction, last_events: game.lastEvents,
    created_at: game.createdAt, updated_at: game.updatedAt, finished_at: game.finishedAt,
  };
}

async function createWorld() {
  const memory = createMemoryRepository();
  const created = await memory.repository.create(createGame([...CHARACTER_IDS]));
  const id = created.id;
  const subscribers = new Set<RealtimeHandlers>();
  const requests: string[] = [];
  let seed = 7;
  const rollDie = () => 1 + Math.floor((((seed = (seed * 16807) % 2147483647) - 1) / 2147483646) * 6);
  let tokens = 0;
  let offline = false;
  let realtimeEnabled = true;
  /** Si > 0: las siguientes N peticiones de avance reciben 429 con Retry-After: 3. */
  let rateLimited = 0;

  // Realtime: difunde cada fila tras una reserva (misma versión) o una confirmación.
  const broadcast = async () => {
    const row = memory.rows.get(id)!;
    if (!realtimeEnabled) return;
    const payload = toRow({ ...row.game }, row.lockToken);
    for (const s of subscribers) queueMicrotask(() => s.onRow(structuredClone(payload)));
  };
  const repository = {
    ...memory.repository,
    claim: async (...args: Parameters<typeof memory.repository.claim>) => {
      const r = await memory.repository.claim(...args);
      if (r) await broadcast();
      return r;
    },
    commit: async (...args: Parameters<typeof memory.repository.commit>) => {
      const r = await memory.repository.commit(...args);
      if (r) await broadcast();
      return r;
    },
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (offline) throw new TypeError("fetch failed");
    if (method === "POST" && url === `/api/games/${id}/advance`) {
      if (rateLimited > 0) {
        rateLimited--;
        return Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "3" } });
      }
      const { expectedVersion } = JSON.parse(String(init!.body));
      const result = await advanceGame(id, expectedVersion, { repository, rollDie, newToken: () => `t${++tokens}` });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (result.kind === "advanced") {
        const g = result.game;
        return Response.json({ id: g.id, version: g.version, status: g.status, winner: g.winner, action: result.action, events: result.events, state: g.state });
      }
      if (result.kind === "not_found") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const currentVersion = "currentVersion" in result ? result.currentVersion : "version" in result ? result.version : undefined;
      return Response.json({ error: { code: result.kind }, currentVersion }, { status: 409 });
    }
    if (method === "GET" && url === `/api/games/${id}`) {
      const game = await memory.repository.get(id);
      return game ? Response.json(toGameResponse(game)) : Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  });

  const subscribe = vi.fn((_gameId: string, handlers: RealtimeHandlers) => {
    subscribers.add(handlers);
    queueMicrotask(() => handlers.onStatus("SUBSCRIBED"));
    return () => subscribers.delete(handlers);
  });

  const deps = { fetch: fetch as unknown as typeof globalThis.fetch, subscribe, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };

  /** Espectador: controlador + "vista" que termina cada animación al instante (registra los pasos). */
  const spectator = (initial?: GameResponse) => {
    const start = initial ?? toGameResponse(memory.rows.get(id)!.game);
    const controller = new LiveGameController(start, deps, { pauseMs: 10, waitMs: 20 });
    const steps: { kind: string; version: number }[] = [];
    let last: number | null = null;
    controller.subscribe(() => {
      const anim = controller.getSnapshot().animation;
      if (anim && anim.seq !== last) {
        last = anim.seq;
        steps.push({ kind: anim.step.kind, version: anim.step.to.version });
        queueMicrotask(() => controller.animationDone(anim.seq));
      }
    });
    return { controller, steps };
  };

  return {
    id, memory, fetch, subscribe, subscribers, requests, spectator,
    serverVersion: () => memory.rows.get(id)!.game.version,
    setOffline: (v: boolean) => (offline = v),
    setRealtime: (v: boolean) => (realtimeEnabled = v),
    setRateLimited: (n: number) => (rateLimited = n),
    emitStatus: (status: RealtimeStatus) => subscribers.forEach((s) => s.onStatus(status)),
  };
}

async function runUntil(cond: () => boolean, maxMs = 600_000) {
  for (let t = 0; t < maxMs && !cond(); t += 50) await vi.advanceTimersByTimeAsync(50);
  if (!cond()) throw new Error("no se cumplió la condición a tiempo");
}

describe("LiveGameController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("un espectador juega la partida completa: cada versión se anima una vez, en orden, y al terminar se detiene", async () => {
    const world = await createWorld();
    const { controller, steps } = world.spectator();
    controller.start();
    await runUntil(() => controller.getSnapshot().connection.kind === "finished");
    await vi.advanceTimersByTimeAsync(100);

    const final = world.serverVersion();
    expect(world.memory.rows.get(world.id)!.game.status).toBe("finished");
    // Ninguna versión duplicada ni saltada: 2, 3, …, final (aunque llegan por advance y por Realtime).
    expect(steps.map((s) => s.version)).toEqual(Array.from({ length: final - 1 }, (_, i) => i + 2));
    expect(steps.every((s) => s.kind === "animate")).toBe(true);
    const view = controller.getSnapshot();
    expect(view.display.version).toBe(final);
    expect(view.display.state).toEqual(world.memory.rows.get(world.id)!.game.state);
    expect(view.display.finishedAt).not.toBeNull(); // fechas definitivas tras la resincronización final
    // Detenido: sin suscripción y sin más peticiones.
    expect(world.subscribers.size).toBe(0);
    const count = world.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.fetch.mock.calls.length).toBe(count);
  });

  it("tres espectadores a la vez: la partida avanza sin duplicar versiones y todos terminan con el mismo estado", async () => {
    const world = await createWorld();
    const spectators = [world.spectator(), world.spectator(), world.spectator()];
    spectators.forEach((s) => s.controller.start());
    await runUntil(() => spectators.every((s) => s.controller.getSnapshot().connection.kind === "finished"));

    const final = world.memory.rows.get(world.id)!.game;
    for (const { controller, steps } of spectators) {
      expect(controller.getSnapshot().display.state).toEqual(final.state);
      const shown = steps.map((s) => s.version);
      expect(new Set(shown).size).toBe(shown.length); // ninguna versión mostrada dos veces
      expect(shown).toEqual([...shown].sort((a, b) => a - b)); // siempre en orden
    }
    // Cada versión es exactamente una acción (el repositorio solo acepta versión + 1).
    expect(final.version).toBeGreaterThan(100);
    // Ningún GET por versión: solo la resincronización al suscribirse y la final de cada espectador.
    expect(world.requests.filter((r) => r.startsWith("GET")).length).toBeLessThanOrEqual(2 * spectators.length);
  });

  it("409 version_conflict: sin GET si la versión llega por Realtime (antes o dentro del margen); con GET si no", async () => {
    /**
     * Otro espectador avanza a v2 justo antes que nosotros. Realtime nos entrega v2 `realtimeAt` ms
     * después del 409 (negativo: antes; null: nunca). `connected`: Realtime en estado SUBSCRIBED.
     */
    async function scenario(realtimeAt: number | null, connected = true) {
      const world = await createWorld();
      const v1 = toGameResponse(world.memory.rows.get(world.id)!.game);
      let handlers: RealtimeHandlers | null = null;
      const gets: string[] = [];
      let started = false;
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          if (started) gets.push(String(input)); // sin contar la resincronización al suscribirse
          return Response.json(toGameResponse(world.memory.rows.get(world.id)!.game));
        }
        const other = await advanceGame(world.id, 1, { repository: world.memory.repository, rollDie: () => 3, newToken: () => "otro" });
        if (other.kind === "advanced" && realtimeAt !== null) {
          const row = toRow(other.game);
          if (realtimeAt <= 0) handlers!.onRow(row);
          else setTimeout(() => handlers!.onRow(row), realtimeAt);
        }
        return Response.json({ error: { code: "version_conflict" }, currentVersion: 2 }, { status: 409 });
      });
      const controller = new LiveGameController(
        v1,
        {
          fetch: fetch as unknown as typeof globalThis.fetch,
          subscribe: (_id, h) => {
            handlers = h;
            if (connected) h.onStatus("SUBSCRIBED");
            return () => {};
          },
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        { pauseMs: 10, realtimeGraceMs: 400 },
      );
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      started = true;
      await vi.advanceTimersByTimeAsync(1000);
      controller.stop();
      return { gets: gets.length, version: controller.getSnapshot().latest.version, posts: fetch.mock.calls.filter(([, i]) => i?.method === "POST").length };
    }

    expect(await scenario(-1)).toEqual({ gets: 0, version: 2, posts: 1 }); // llegó antes que el 409
    expect(await scenario(150)).toEqual({ gets: 0, version: 2, posts: 1 }); // llegó dentro del margen
    expect(await scenario(null)).toMatchObject({ gets: 1, version: 2 }); // no llegó: GET tras el margen
    expect(await scenario(null, false)).toMatchObject({ gets: 1, version: 2 }); // Realtime caído: GET directo
  });

  it("al detenerse (salir de la página) cancela la petición en curso y no pide más avances", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    controller.start();
    await runUntil(() => world.serverVersion() >= 5);
    controller.stop();
    const version = world.serverVersion();
    const calls = world.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.fetch.mock.calls.length).toBe(calls);
    expect(world.serverVersion()).toBeLessThanOrEqual(version + 1); // como mucho, la que ya estaba en vuelo
    expect(world.subscribers.size).toBe(0);
  });

  it("con la pestaña oculta no avanza; al volver se pone al día y sigue", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    controller.start();
    await runUntil(() => world.serverVersion() >= 3);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(500);
    const paused = world.serverVersion();
    expect(controller.getSnapshot().connection.kind).toBe("paused");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(world.serverVersion()).toBe(paused);
    controller.setVisible(true);
    await runUntil(() => world.serverVersion() >= paused + 3);
    expect(controller.getSnapshot().connection.kind).toBe("live");
    controller.stop();
  });

  it("errores de red: reintenta con espera creciente, sin perder ni duplicar versiones, y se recupera", async () => {
    const world = await createWorld();
    const { controller, steps } = world.spectator();
    controller.start();
    await runUntil(() => world.serverVersion() >= 3);
    world.setOffline(true);
    await runUntil(() => controller.getSnapshot().connection.kind === "retrying");
    const offlineVersion = world.serverVersion();
    await vi.advanceTimersByTimeAsync(4_000);
    const view = controller.getSnapshot();
    expect(view.connection).toMatchObject({ kind: "retrying", message: "Sin conexión con el servidor." });
    expect(world.serverVersion()).toBe(offlineVersion);
    world.setOffline(false);
    await runUntil(() => world.serverVersion() >= offlineVersion + 3);
    expect(controller.getSnapshot().connection.kind).toBe("live");
    const shown = steps.map((s) => s.version);
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => i + 2));
    controller.stop();
  });

  it("al recuperar la red (evento online o Realtime SUBSCRIBED) avanza enseguida, sin esperar al reintento", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    controller.start();
    await runUntil(() => world.serverVersion() >= 3);
    world.setOffline(true);
    await vi.advanceTimersByTimeAsync(20_000); // varios fallos: la espera ya va por 15 s
    expect(controller.getSnapshot().connection).toMatchObject({ kind: "retrying" });
    const version = world.serverVersion();
    world.setOffline(false);
    controller.networkRestored();
    await vi.advanceTimersByTimeAsync(300); // mucho menos que la espera pendiente
    expect(world.serverVersion()).toBeGreaterThan(version);
    expect(controller.getSnapshot().connection.kind).toBe("live");
    controller.stop();
  });

  it("reconexión de Realtime: al volver a SUBSCRIBED resincroniza y recupera lo avanzado por otros", async () => {
    const world = await createWorld();
    const watcher = world.spectator(); // solo observa: no se arranca su bucle de avance
    const { controller, steps } = watcher;
    // Arranca y se pausa (pestaña oculta) para que solo avance el otro espectador.
    controller.start();
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(100);
    world.emitStatus("CHANNEL_ERROR");
    expect(controller.getSnapshot().connection.kind).toBe("paused");
    world.setRealtime(false); // durante el corte no llega nada por Realtime
    const other = world.spectator();
    other.controller.start();
    await runUntil(() => world.serverVersion() >= 12);
    other.controller.stop();
    expect(controller.getSnapshot().display.version).toBeLessThan(world.serverVersion());
    world.setRealtime(true);
    world.emitStatus("SUBSCRIBED"); // reconectado → GET de resincronización
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.getSnapshot().display.version).toBe(world.serverVersion());
    expect(steps.at(-1)).toMatchObject({ kind: "jump" }); // varias versiones de golpe: sin animar las intermedias
    controller.stop();
  });

  it("429 por límite de peticiones: espera el Retry-After (sin insistir antes) y después sigue", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    controller.start();
    await runUntil(() => world.serverVersion() >= 3);
    world.setRateLimited(2);
    const posts = () => world.requests.filter((r) => r.startsWith("POST")).length;
    await runUntil(() => controller.getSnapshot().connection.kind === "retrying");
    expect(controller.getSnapshot().connection).toMatchObject({ message: "Demasiadas peticiones; esperando…" });
    const before = posts();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(posts()).toBe(before); // no reintenta antes de los 3 s
    await vi.advanceTimersByTimeAsync(200);
    expect(posts()).toBe(before + 1); // segundo 429
    const version = world.serverVersion();
    await runUntil(() => world.serverVersion() > version + 2);
    expect(controller.getSnapshot().connection.kind).toBe("live");
    controller.stop();
  });

  it("partida terminada al abrir: no se suscribe ni pide nada", async () => {
    const world = await createWorld();
    const initial = toGameResponse(world.memory.rows.get(world.id)!.game);
    const finished: GameResponse = { ...initial, status: "finished", winner: "ai-green", state: { ...initial.state, status: "finished", winner: "ai-green", ranking: ["ai-green"] } };
    const { controller } = world.spectator(finished);
    controller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(world.subscribe).not.toHaveBeenCalled();
    expect(world.fetch).not.toHaveBeenCalled();
    expect(controller.getSnapshot().connection.kind).toBe("finished");
  });

  it("partida borrada (404): muestra el error y se detiene", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    world.memory.rows.delete(world.id);
    controller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot().connection).toEqual({ kind: "error", message: "La partida ya no existe." });
    const calls = world.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.fetch.mock.calls.length).toBe(calls);
  });

  it("boardVersion (para el chat) solo avanza cuando el tablero termina de animar la versión", async () => {
    const world = await createWorld();
    const controller = new LiveGameController(toGameResponse(world.memory.rows.get(world.id)!.game), {
      fetch: world.fetch as unknown as typeof fetch,
      subscribe: world.subscribe,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }, { pauseMs: 10 });
    controller.start();
    await runUntil(() => controller.getSnapshot().animation !== null);
    const { animation, boardVersion, display } = controller.getSnapshot();
    expect(display.version).toBe(2);
    expect(boardVersion).toBe(1); // aún animando: los mensajes de la v2 no se muestran
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getSnapshot().boardVersion).toBe(1); // sin animationDone no avanza nada
    controller.animationDone(animation!.seq);
    expect(controller.getSnapshot().boardVersion).toBe(2);
    controller.stop();
  });
});

