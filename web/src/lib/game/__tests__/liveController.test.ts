// Controlador en directo contra un "mundo" falso: servidor con el advanceGame real sobre el
// repositorio en memoria (reproduce el trigger), Realtime que difunde cada cambio y reloj falso.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAction, createGame } from "@/lib/engine";
import { advanceGame } from "../advance";
import { decideAction } from "../ai";
import { toGameResponse, type GameResponse } from "../api";
import { CHARACTER_IDS } from "../characters";
import { LOG_SIZE, LiveGameController, type LiveOptions, type RealtimeHandlers, type RealtimeStatus } from "../liveController";
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

interface WorldOptions {
  /** Tiempo que el servidor retiene la reserva antes de confirmar (decisión, LLM…); por reserva concedida. */
  serverMs?: number | ((claim: number) => number);
  /** Retraso de Realtime al entregar cada fila (por defecto, una microtarea). */
  realtimeMs?: number;
  /** Reloj de la "BD" = reloj falso de Vitest (para que las reservas de 20 s caduquen de verdad). */
  realClock?: boolean;
}

/** Respuesta recibida por un espectador (para medir los 409). */
interface Logged {
  who: string;
  method: string;
  status: number;
  code?: string;
  expected?: number;
}

async function createWorld(opts: WorldOptions = {}) {
  const memory = createMemoryRepository(opts.realClock ? { get now() { return Date.now(); } } : undefined);
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
    for (const s of subscribers) {
      const deliver = () => subscribers.has(s) && s.onRow(structuredClone(payload));
      if (opts.realtimeMs) setTimeout(deliver, opts.realtimeMs);
      else queueMicrotask(deliver);
    }
  };
  let claims = 0;
  const repository = {
    ...memory.repository,
    claim: async (...args: Parameters<typeof memory.repository.claim>) => {
      const r = await memory.repository.claim(...args);
      if (r) {
        await broadcast();
        const ms = typeof opts.serverMs === "function" ? opts.serverMs(++claims) : opts.serverMs;
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms)); // reserva retenida
      }
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

  const responses: Logged[] = [];
  let spectators = 0;

  /**
   * Espectador: controlador + "vista" que termina cada animación al instante o a los `animMs` (registra los
   * pasos). Sus respuestas quedan en `responses` con su nombre.
   */
  const spectator = (initial?: GameResponse, { options, animMs, name }: { options?: LiveOptions; animMs?: number; name?: string } = {}) => {
    const who = name ?? `e${++spectators}`;
    const start = initial ?? toGameResponse(memory.rows.get(id)!.game);
    const tagged = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      const method = init?.method ?? "GET";
      const code = response.status === 409 ? ((await response.clone().json()) as { error: { code: string } }).error.code : undefined;
      const expected = method === "POST" ? (JSON.parse(String(init!.body)) as { expectedVersion: number }).expectedVersion : undefined;
      responses.push({ who, method, status: response.status, code, expected });
      return response;
    };
    const controller = new LiveGameController(start, { ...deps, fetch: tagged as typeof globalThis.fetch }, { pauseMs: 10, waitMs: 20, ...options });
    const steps: { kind: string; version: number }[] = [];
    let last: number | null = null;
    controller.subscribe(() => {
      const anim = controller.getSnapshot().animation;
      if (anim && anim.seq !== last) {
        last = anim.seq;
        steps.push({ kind: anim.step.kind, version: anim.step.to.version });
        if (animMs) setTimeout(() => controller.animationDone(anim.seq), animMs);
        else queueMicrotask(() => controller.animationDone(anim.seq));
      }
    });
    return { controller, steps, who };
  };

  return {
    id, memory, repository, fetch, subscribe, subscribers, requests, responses, spectator,
    serverVersion: () => memory.rows.get(id)!.game.version,
    setOffline: (v: boolean) => (offline = v),
    setRealtime: (v: boolean) => (realtimeEnabled = v),
    setRateLimited: (n: number) => (rateLimited = n),
    emitStatus: (status: RealtimeStatus) => subscribers.forEach((s) => s.onStatus(status)),
  };
}

const posts = (responses: Logged[]) => responses.filter((r) => r.method === "POST");
const conflicts = (responses: Logged[]) => posts(responses).filter((r) => r.status === 409).length;
const gets = (responses: Logged[]) => responses.filter((r) => r.method === "GET").length;

/** POST que repiten la misma versión justo después de recibir turn_in_progress (por espectador). */
function repeatedAfterTurn(responses: Logged[]): number {
  const last = new Map<string, Logged>();
  let repeated = 0;
  for (const r of posts(responses)) {
    const prev = last.get(r.who);
    if (prev?.code === "turn_in_progress" && prev.expected === r.expected) repeated++;
    last.set(r.who, r);
  }
  return repeated;
}

/** Tiempos parecidos a los reales: Realtime 150 ms, animación 250 ms y servidor 300 ms (2,5 s cada 5 reservas, como con el LLM). */
const REALISTIC: WorldOptions = { serverMs: (claim) => (claim % 5 === 0 ? 2500 : 300), realtimeMs: 150 };
/** Opciones del controlador con el ritmo real y, sin el retraso ni la espera por Realtime, el comportamiento anterior. */
const REAL_PACE: LiveOptions = { pauseMs: 450, waitMs: 1000 };
const LEGACY: LiveOptions = { ...REAL_PACE, followerDelayMs: 0, turnGraceMs: 0 };

/**
 * `n` espectadores con tiempos realistas hasta la versión `target`. Después dejan de pedir avances (pestaña
 * oculta) y se comprueba que todos acaban en el estado del servidor, sin versiones repetidas ni desordenadas, y
 * que cada turno se aplicó una vez (Σ 200 = versiones − 1).
 */
async function crowd(n: number, options: LiveOptions, target = 60) {
  const world = await createWorld(REALISTIC);
  const spectators = Array.from({ length: n }, () => world.spectator(undefined, { options, animMs: 250 }));
  spectators.forEach((s) => s.controller.start());
  await runUntil(() => world.serverVersion() >= target);
  spectators.forEach((s) => s.controller.setVisible(false));
  await vi.advanceTimersByTimeAsync(10_000); // peticiones en vuelo, Realtime y animaciones pendientes

  const final = world.memory.rows.get(world.id)!.game;
  for (const { controller, steps } of spectators) {
    expect(controller.getSnapshot().display.version).toBe(final.version);
    expect(controller.getSnapshot().display.state).toEqual(final.state);
    const shown = steps.map((s) => s.version);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    controller.stop();
  }
  const ok = posts(world.responses).filter((r) => r.status === 200).length;
  expect(ok).toBe(final.version - 1); // cada versión, un único avance
  return { conflicts: conflicts(world.responses), repeated: repeatedAfterTurn(world.responses), posts: posts(world.responses).length, versions: final.version };
}

/** Reserva el turno de la v1 como "otro espectador" (sin difundirlo) y devuelve cómo confirmarlo como v2. */
async function holdTurn(world: Awaited<ReturnType<typeof createWorld>>) {
  const claimed = (await world.memory.repository.claim(world.id, 1, "ajeno"))!;
  const action = decideAction(claimed.state, () => 3);
  const result = applyAction(claimed.state, action);
  if (!result.ok) throw new Error(result.error);
  return () => world.repository.commit(world.id, 1, "ajeno", { state: result.state, action, events: result.events });
}

async function runUntil(cond: () => boolean, maxMs = 600_000) {
  for (let t = 0; t < maxMs && !cond(); t += 50) await vi.advanceTimersByTimeAsync(50);
  if (!cond()) throw new Error("no se cumplió la condición a tiempo");
}

describe("LiveGameController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("«Últimas jugadas» conserva más de 9 entradas (hasta LOG_SIZE), de la más reciente a la más antigua y sin duplicados", async () => {
    const world = await createWorld();
    const { controller } = world.spectator();
    controller.start();
    await runUntil(() => controller.getSnapshot().display.version >= 120);
    controller.stop();
    const log = controller.getSnapshot().log;
    expect(LOG_SIZE).toBe(60);
    expect(log.length).toBeGreaterThan(9);
    expect(log.length).toBeLessThanOrEqual(LOG_SIZE);
    expect(new Set(log.map((e) => e.id)).size).toBe(log.length);
    // Cada id es versión × 100 + posición: las versiones van de la más reciente a la más antigua.
    const versions = log.map((e) => Math.floor(e.id / 100));
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
  });

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
        { pauseMs: 10, realtimeGraceMs: 400, followerDelayMs: 0 }, // el primer POST sale enseguida
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

describe("LiveGameController: varios espectadores de la misma partida", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dos y tres espectadores: sincronizados, sin turnos duplicados y con menos 409 que antes", async () => {
    for (const n of [2, 3]) {
      const before = await crowd(n, LEGACY);
      const after = await crowd(n, REAL_PACE);
      // Antes: choques en casi todas las versiones y POST repetidos tras turn_in_progress.
      expect(before.conflicts, `${n} espectadores, antes`).toBeGreaterThan(0);
      expect(before.repeated, `${n} espectadores, antes`).toBeGreaterThan(0);
      // Ahora: menos 409 y ningún POST repetido mientras otro resuelve el turno.
      expect(after.conflicts, `${n} espectadores`).toBeLessThan(before.conflicts);
      expect(after.repeated, `${n} espectadores`).toBe(0);
    }
  });

  it("turn_in_progress con Realtime: un solo POST mientras otro resuelve el turno, sin GET, y sigue al llegar la versión", async () => {
    const world = await createWorld({ realClock: true });
    const confirm = await holdTurn(world);
    const { controller } = world.spectator(undefined, { options: { followerDelayMs: 0 } });
    controller.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(posts(world.responses)).toEqual([expect.objectContaining({ status: 409, code: "turn_in_progress", expected: 1 })]);
    expect(gets(world.responses)).toBe(1); // solo la resincronización al suscribirse
    await confirm(); // el otro confirma la v2: llega por Realtime
    await runUntil(() => world.serverVersion() >= 4);
    expect(gets(world.responses)).toBe(1);
    expect(controller.getSnapshot().latest.version).toBeGreaterThanOrEqual(3);
    expect(repeatedAfterTurn(world.responses)).toBe(0);
    controller.stop();
  });

  it("turn_in_progress sin entrega por Realtime: GET al acabar el plazo (5 s) y continúa", async () => {
    const world = await createWorld({ realClock: true });
    const confirm = await holdTurn(world);
    const { controller } = world.spectator(undefined, { options: { followerDelayMs: 0 } });
    controller.start();
    await vi.advanceTimersByTimeAsync(100);
    world.setRealtime(false); // conectado, pero la v2 no llegará
    await vi.advanceTimersByTimeAsync(900);
    await confirm();
    await vi.advanceTimersByTimeAsync(3_800); // ~4,8 s desde el 409
    expect(posts(world.responses)).toHaveLength(1);
    expect(gets(world.responses)).toBe(1);
    expect(controller.getSnapshot().latest.version).toBe(1);
    await vi.advanceTimersByTimeAsync(400); // vence el plazo: GET
    expect(gets(world.responses)).toBe(2);
    // El GET trae la v2 y, sin nadie más, sigue avanzando con sus propios POST (ya sin 409).
    expect(controller.getSnapshot().latest.version).toBeGreaterThanOrEqual(2);
    expect(posts(world.responses).slice(1).every((r) => r.status === 200)).toBe(true);
    await runUntil(() => world.serverVersion() >= 5);
    expect(repeatedAfterTurn(world.responses)).toBe(0);
    controller.stop();
  });

  it("si quien tenía el turno muere, se recupera al caducar su reserva (20 s) con pocos POST", async () => {
    async function recover(options: LiveOptions) {
      const world = await createWorld({ realClock: true });
      await holdTurn(world); // nunca se confirma
      const { controller } = world.spectator(undefined, { options: { followerDelayMs: 0, waitMs: 1000, ...options } });
      controller.start();
      await runUntil(() => world.serverVersion() >= 3, 60_000);
      controller.stop();
      return posts(world.responses).filter((r) => r.code === "turn_in_progress").length;
    }
    const now = await recover({});
    const before = await recover({ turnGraceMs: 0 });
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThanOrEqual(5); // un intento cada ~5 s durante los 20 s de la reserva
    expect(now).toBeLessThan(before); // antes: uno por segundo
  });

  it("sin Realtime conectado, turn_in_progress conserva la espera y el reintento de siempre", async () => {
    const world = await createWorld({ realClock: true });
    await holdTurn(world);
    const { controller } = world.spectator(undefined, { options: { followerDelayMs: 0, waitMs: 20 } });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    world.emitStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(300);
    expect(posts(world.responses).length).toBeGreaterThan(3);
    expect(posts(world.responses).every((r) => r.code === "turn_in_progress" && r.expected === 1)).toBe(true);
    controller.stop();
  });

  it("stop() durante la espera de turn_in_progress cancela sus temporizadores y no pide nada más", async () => {
    const world = await createWorld({ realClock: true });
    const confirm = await holdTurn(world);
    const { controller } = world.spectator(undefined, { options: { followerDelayMs: 0 } });
    controller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts(world.responses)).toHaveLength(1);
    controller.stop();
    expect(vi.getTimerCount()).toBe(0); // ni la espera de 5 s ni el bucle de avance
    await confirm();
    const calls = world.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.fetch.mock.calls.length).toBe(calls);
    expect(controller.getSnapshot().latest.version).toBe(1);
  });

  it("quien recibe las versiones de otro no pide avances mientras el otro sigue (sin temporizadores obsoletos)", async () => {
    // Sin animación (como una tirada): la versión nueva llega con el avance anterior aún programado.
    const world = await createWorld({ serverMs: 300, realtimeMs: 150 });
    const a = world.spectator(undefined, { options: REAL_PACE, name: "a" });
    const b = world.spectator(undefined, { options: REAL_PACE, name: "b" });
    a.controller.start();
    await runUntil(() => world.serverVersion() >= 3);
    b.controller.start(); // llega con la partida en marcha
    await runUntil(() => world.serverVersion() >= 40);
    expect(posts(world.responses).filter((r) => r.who === "b")).toHaveLength(0);
    expect(conflicts(world.responses)).toBe(0);
    a.controller.stop();
    b.controller.stop();
  });

  it("versiones que llegan mientras se anima: sin avances duplicados y la programación sigue al terminar", async () => {
    const world = await createWorld({ serverMs: 300, realtimeMs: 150 });
    const fast = world.spectator(undefined, { options: REAL_PACE, animMs: 100, name: "rapido" });
    const slow = world.spectator(undefined, { options: REAL_PACE, animMs: 1_500, name: "lento" }); // anima más que el ciclo del otro
    fast.controller.start();
    await runUntil(() => world.serverVersion() >= 2);
    slow.controller.start();
    await runUntil(() => world.serverVersion() >= 30);
    expect(posts(world.responses).filter((r) => r.who === "lento")).toHaveLength(0);
    fast.controller.stop();
    const version = world.serverVersion();
    await runUntil(() => world.serverVersion() >= version + 5, 60_000); // el lento toma el relevo
    const shown = slow.steps.map((s) => s.version);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(posts(world.responses).filter((r) => r.who === "lento" && r.status === 409)).toHaveLength(0);
    slow.controller.stop();
  });

  it("si el espectador que avanzaba se va, el otro toma el relevo y vuelve al ritmo normal", async () => {
    for (const leaves of ["first", "second"] as const) {
      const world = await createWorld(REALISTIC);
      const pair = [world.spectator(undefined, { options: REAL_PACE, animMs: 250 }), world.spectator(undefined, { options: REAL_PACE, animMs: 250 })];
      pair.forEach((s) => s.controller.start());
      await runUntil(() => world.serverVersion() >= 20);
      const leader = posts(world.responses).filter((r) => r.status === 200).at(-1)!.who;
      const gone = leaves === "first" ? pair.find((s) => s.who === leader)! : pair.find((s) => s.who !== leader)!;
      const stays = pair.find((s) => s !== gone)!;
      gone.controller.stop();
      const goneRequests = world.responses.filter((r) => r.who === gone.who).length;
      const version = world.serverVersion();
      await runUntil(() => world.serverVersion() >= version + 10, 120_000);
      expect(world.responses.filter((r) => r.who === gone.who).length).toBeLessThanOrEqual(goneRequests + 1); // como mucho la que estaba en vuelo
      await vi.advanceTimersByTimeAsync(3_000);
      stays.controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stays.controller.getSnapshot().display.version).toBe(world.serverVersion());
      stays.controller.stop();
    }
  });
});
