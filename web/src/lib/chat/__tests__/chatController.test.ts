// Chat en el navegador: modelo puro (feed) y controlador contra un "mundo" falso con el almacén en
// memoria, Realtime que difunde cada inserción, el endpoint de mensajes y reloj falso.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveChatController, type ChatRealtimeHandlers } from "../chatController";
import { CHAT_LIMITS } from "../config";
import { FEED_LIMIT, maxMessageId, mergeMessages, visibleMessages } from "../feed";
import { toChatMessage, type ChatMessage, type ChatMessageRow } from "../schemas";
import { drainChat, type ChatDeps } from "../service";
import { createLocalWriter } from "../writer";
import { createSeededRandom } from "@/lib/game/ai";
import { createMemoryChatStore } from "./memoryChatStore";

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

const msg = (id: number, version: number, seq = 0): ChatMessage => ({
  id, version, seq, characterId: "ai-pink", trigger: "capture", replyToSeq: seq === 0 ? null : 0, text: `m${id}`, createdAt: "2026-11-11T10:00:00Z",
});
const row = (version: number, seq = 0, text = `v${version}s${seq}`): Omit<ChatMessageRow, "id"> => ({
  game_id: GAME, version, seq, character_id: seq === 0 ? "ai-pink" : "ai-blue", trigger: "capture",
  reply_to_seq: seq === 0 ? null : 0, text, source: "local", created_at: "2026-11-11T10:00:00Z",
});

describe("feed", () => {
  it("sin duplicados, en orden de conversación (versión y seq) y con límite", () => {
    let feed = mergeMessages([], [msg(2, 10, 1), msg(1, 10, 0)]);
    expect(feed.map((m) => m.id)).toEqual([1, 2]);
    const same = mergeMessages(feed, [msg(1, 10, 0), msg(2, 10, 1)]);
    expect(same).toBe(feed); // nada nuevo → mismo array (sin re-render)
    feed = mergeMessages(feed, [msg(5, 30), msg(3, 20)]);
    expect(feed.map((m) => m.version)).toEqual([10, 10, 20, 30]);
    expect(maxMessageId(feed)).toBe(5);
    const many = mergeMessages([], Array.from({ length: FEED_LIMIT + 10 }, (_, i) => msg(i + 1, i + 1)));
    expect(many).toHaveLength(FEED_LIMIT);
    expect(many[0].id).toBe(11);
  });

  it("solo son visibles los mensajes de versiones que el tablero ya mostró", () => {
    const feed = [msg(1, 10), msg(2, 10, 1), msg(3, 12)];
    expect(visibleMessages(feed, 9)).toEqual([]);
    expect(visibleMessages(feed, 10).map((m) => m.id)).toEqual([1, 2]);
    expect(visibleMessages(feed, 12)).toHaveLength(3);
  });
});

function createWorld() {
  const memory = createMemoryChatStore();
  const local = createLocalWriter(createSeededRandom(4));
  let tokens = 0;
  const drainDeps: ChatDeps = { store: memory.store, writer: local, fallbackWriter: local, random: () => 0, newToken: () => `t${++tokens}` };
  const subscribers = new Set<ChatRealtimeHandlers>();
  let realtime = true;
  let offline = false;
  let rateLimited = 0;
  const requests: string[] = [];

  memory.onInsert((inserted) => {
    if (!realtime) return;
    for (const s of subscribers) queueMicrotask(() => s.onRow(structuredClone(inserted)));
  });

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url.pathname + url.search);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (offline) throw new TypeError("fetch failed");
    if (rateLimited > 0) {
      rateLimited--;
      return Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "4" } });
    }
    const after = Number(url.searchParams.get("after"));
    const messages = await memory.store.after(GAME, after, CHAT_LIMITS.pageSize);
    const pending = await memory.store.pending(GAME);
    // Como la ruta real: si quedan pendientes, el procesador se pone en marcha tras responder.
    if (pending) setTimeout(() => void drainChat(GAME, drainDeps), 0);
    return Response.json({ messages, hasMore: messages.length === CHAT_LIMITS.pageSize, pending });
  });

  const subscribe = vi.fn((_id: string, handlers: ChatRealtimeHandlers) => {
    subscribers.add(handlers);
    queueMicrotask(() => handlers.onStatus("SUBSCRIBED"));
    return () => subscribers.delete(handlers);
  });

  const controller = (initial: ChatMessage[] = []) =>
    new LiveChatController(GAME, initial, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      subscribe,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

  return {
    memory, fetch, requests, subscribers, controller,
    setRealtime: (v: boolean) => (realtime = v),
    setOffline: (v: boolean) => (offline = v),
    setRateLimited: (n: number) => (rateLimited = n),
    resubscribe: () => subscribers.forEach((s) => s.onStatus("SUBSCRIBED")),
  };
}

const ids = (c: LiveChatController) => c.getSnapshot().messages.map((m) => m.id);

describe("LiveChatController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("carga inicial + recuperación al suscribirse + mensajes por Realtime, sin duplicados", async () => {
    const world = createWorld();
    const initial = [world.memory.insertRow(row(5)), world.memory.insertRow(row(5, 1))].map(toChatMessage);
    world.memory.insertRow(row(9)); // llegó entre la carga en el servidor y la suscripción
    const chat = world.controller(initial);
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(world.requests).toEqual([`/api/games/${GAME}/messages?after=2`]);
    expect(ids(chat)).toEqual([1, 2, 3]);

    world.memory.insertRow(row(12));
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(chat)).toEqual([1, 2, 3, 4]);
    // Un GET que devuelve lo mismo que Realtime no duplica.
    world.resubscribe();
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(chat)).toEqual([1, 2, 3, 4]);
    expect(world.requests.at(-1)).toBe(`/api/games/${GAME}/messages?after=4`);
    chat.stop();
  });

  it("reconexión: recupera todo lo insertado mientras Realtime estaba caído, por páginas", async () => {
    const world = createWorld();
    const chat = world.controller();
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    world.setRealtime(false);
    for (let v = 1; v <= CHAT_LIMITS.pageSize + 30; v++) world.memory.insertRow(row(v));
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(chat)).toEqual([]);
    world.setRealtime(true);
    world.resubscribe();
    await vi.advanceTimersByTimeAsync(10);
    expect(world.requests.slice(-2)).toEqual([`/api/games/${GAME}/messages?after=0`, `/api/games/${GAME}/messages?after=100`]);
    expect(chat.getSnapshot().messages).toHaveLength(FEED_LIMIT);
    expect(chat.getSnapshot().messages.at(-1)!.id).toBe(130);
    chat.stop();
  });

  it("sin red: reintenta con espera creciente y recupera al volver (o enseguida con resync)", async () => {
    const world = createWorld();
    const chat = world.controller();
    world.setOffline(true);
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    world.memory.insertRow(row(3));
    const before = world.requests.length;
    await vi.advanceTimersByTimeAsync(3_100); // 1 s + 2 s
    expect(world.requests.length - before).toBe(2);
    world.setOffline(false);
    chat.resync(); // evento online / pestaña visible
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(chat)).toEqual([1]);
    // Ya no quedan reintentos pendientes.
    const after = world.requests.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.requests.length).toBe(after);
    chat.stop();
  });

  it("429: respeta Retry-After antes de volver a pedir", async () => {
    const world = createWorld();
    world.setRateLimited(1);
    const chat = world.controller();
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(world.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(world.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(world.requests).toHaveLength(2);
    chat.stop();
  });

  it("descarta filas de otras partidas o no válidas, y stop() corta la suscripción y los reintentos", async () => {
    const world = createWorld();
    const chat = world.controller();
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    for (const s of world.subscribers) {
      s.onRow({ ...row(4), id: 99, game_id: "00000000-0000-4000-8000-000000000000" });
      s.onRow({ id: "x" });
    }
    expect(ids(chat)).toEqual([]);
    chat.stop();
    expect(world.subscribers.size).toBe(0);
    world.setOffline(true);
    chat.resync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.requests).toHaveLength(1);
  });

  it("partida terminada con el procesador interrumpido: el navegador consulta hasta recuperar la victoria", async () => {
    const world = createWorld();
    const victory = [
      { type: "piece_reached_goal", playerId: "ai-green", pieceIndex: 3 },
      { type: "player_finished", playerId: "ai-green", place: 1 },
    ];
    // Última versión confirmada (encolada) y su procesador muerto tras reservar: nadie más avanza.
    world.memory.enqueue(GAME, 600, victory, {});
    await world.memory.store.claim(GAME, "procesador-muerto", CHAT_LIMITS.leaseSeconds, 25);

    const chat = world.controller();
    chat.start();
    chat.setFinished(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(ids(chat)).toEqual([]);
    // Mientras la reserva no caduca, sigue consultando (pending) con espera creciente…
    await vi.advanceTimersByTimeAsync(CHAT_LIMITS.pendingPollMs * 3);
    expect(world.memory.queue).toHaveLength(1);
    // …y en cuanto caduca, un GET pone en marcha el procesador y llega la victoria (Realtime).
    world.memory.advance(CHAT_LIMITS.leaseSeconds * 1000 + 1);
    await vi.advanceTimersByTimeAsync(CHAT_LIMITS.pendingPollMaxMs + 100);
    expect(world.memory.queue).toEqual([]);
    expect(chat.getSnapshot().messages[0]).toMatchObject({ version: 600, trigger: "victory", characterId: "ai-green" });
    // Sin pendientes, deja de consultar.
    const requests = world.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.requests.length).toBeLessThanOrEqual(requests + 1);
    chat.stop();
  });

  it("en curso no consulta por pendientes (lo hace el siguiente avance); al terminar, comprueba una vez", async () => {
    const world = createWorld();
    world.memory.enqueue(GAME, 5, [], {}); // versión sin nada que comentar aún en la cola
    const chat = world.controller();
    chat.start();
    await vi.advanceTimersByTimeAsync(10);
    const requests = world.requests.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.requests.length).toBe(requests);
    world.memory.queue.splice(0);
    chat.setFinished(true);
    await vi.advanceTimersByTimeAsync(CHAT_LIMITS.pendingPollMs + 10);
    expect(world.requests.length).toBe(requests + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.requests.length).toBe(requests + 1);
    chat.stop();
  });
});

