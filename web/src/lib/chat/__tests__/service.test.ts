import { describe, expect, it } from "vitest";
import { applyAction, createGame, type GameEvent, type GameState } from "@/lib/engine";
import { createSeededRandom, decideAction } from "@/lib/game/ai";
import { CHARACTERS, CHARACTER_IDS, CHARACTER_NAMES } from "@/lib/game/characters";
import { CHAT_LIMITS } from "../config";
import { drainChat, type ChatDeps } from "../service";
import { createLocalWriter, similarity, type ChatWriter } from "../writer";
import { createMemoryChatStore } from "./memoryChatStore";

const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";
const STATE = createGame([...CHARACTER_IDS]);
const capture = (by = "ai-pink", victim = "ai-purple"): GameEvent => ({ type: "piece_captured", playerId: by, victimId: victim, victimPieceIndex: 0, cell: 30 });
const roll: GameEvent = { type: "dice_rolled", playerId: "ai-pink", value: 3 };
const victory = (winner = "ai-green"): GameEvent[] => [
  { type: "piece_reached_goal", playerId: winner, pieceIndex: 3 },
  { type: "player_finished", playerId: winner, place: 1 },
];
const LEASE_MS = CHAT_LIMITS.leaseSeconds * 1000;

/**
 * `writer`: escritor principal (por defecto, el local). `fallback`: escritor de reserva (por defecto,
 * el local). Para simular una versión defectuosa (que no se puede escribir de ninguna forma), se pasa
 * el mismo escritor que falla como reserva.
 */
function setup(writer?: ChatWriter, fallback?: ChatWriter) {
  const memory = createMemoryChatStore();
  let tokens = 0;
  const local = createLocalWriter(createSeededRandom(1));
  const deps: ChatDeps = {
    store: memory.store,
    writer: writer ?? local,
    fallbackWriter: fallback ?? local,
    random: () => 0, // el director siempre "quiere" hablar
    newToken: () => `token-${++tokens}`,
  };
  const enqueue = (version: number, events: GameEvent[], state: GameState = STATE) => memory.enqueue(GAME, version, events, state);
  const drain = () => drainChat(GAME, deps);
  const versions = () => [...new Set(memory.rows.map((r) => r.version))];
  return { memory, deps, enqueue, drain, versions };
}

describe("cola: orden, idempotencia y concurrencia", () => {
  it("procesa las versiones pendientes en orden, de una vez, y vacía la cola", async () => {
    const t = setup();
    t.enqueue(3, [roll]);
    t.enqueue(4, [capture("ai-pink", "ai-purple")]);
    t.enqueue(5, [roll]);
    t.enqueue(9, [capture("ai-blue", "ai-green")]); // pasadas las pausas
    expect(await t.drain()).toMatchObject({ kind: "done", batches: 1, published: 4 });
    expect(t.memory.rows.map((r) => [r.version, r.seq])).toEqual([[4, 0], [4, 1], [9, 0], [9, 1]]);
    expect(t.memory.queue).toEqual([]);
    expect(t.memory.chats.get(GAME)).toMatchObject({ lastVersion: 9, messageCount: 4, lockToken: null });
    expect(await t.drain()).toMatchObject({ kind: "idle" });
  });

  it("fuera de orden: aunque lo dispare la versión más reciente, nada se descarta", async () => {
    const t = setup();
    t.enqueue(10, [capture()]);
    t.enqueue(20, [capture("ai-blue", "ai-green")]);
    await t.drain(); // "disparado" por la 20: procesa la 10 y la 20, en orden
    expect(t.versions()).toEqual([10, 20]);
    t.enqueue(30, [capture("ai-green", "ai-pink")]);
    await t.drain();
    expect(t.versions()).toEqual([10, 20, 30]);
  });

  it("reserva ocupada: no se descarta nada; lo recoge quien tiene la reserva o la siguiente ejecución", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    expect(await t.memory.store.claim(GAME, "otro", CHAT_LIMITS.leaseSeconds, 25)).not.toBeNull();
    t.enqueue(9, [capture("ai-blue", "ai-green")]); // llega mientras el otro procesa
    expect(await t.drain()).toMatchObject({ kind: "idle" });
    expect(t.memory.queue.map((q) => q.version)).toEqual([4, 9]);
    await t.memory.store.release(GAME, "otro");
    await t.drain();
    expect(t.versions()).toEqual([4, 9]);
  });

  it("10 ejecuciones simultáneas: una procesa, ninguna duplica, nada se pierde", async () => {
    const t = setup();
    // Dentro del margen de desfase (todas a menos de 15 versiones de la última).
    for (let v = 2; v <= 20; v++) t.enqueue(v, v % 9 === 0 ? [capture(CHARACTER_IDS[v % 4], CHARACTER_IDS[(v + 1) % 4])] : [roll]);
    const results = await Promise.all(Array.from({ length: 10 }, () => t.drain()));
    expect(results.filter((r) => r.batches > 0)).toHaveLength(1);
    expect(t.memory.queue).toEqual([]);
    expect(t.versions()).toEqual([9, 18]);
    expect(new Set(t.memory.rows.map((r) => `${r.version}:${r.seq}`)).size).toBe(t.memory.rows.length);
  });

  it("lotes: más pendientes que un lote se procesan en varios, en orden", async () => {
    const t = setup();
    for (let v = 2; v <= 80; v++) t.enqueue(v, v % 10 === 4 ? [capture(CHARACTER_IDS[v % 4], CHARACTER_IDS[(v + 2) % 4])] : [roll]);
    const result = await t.drain();
    expect(result).toMatchObject({ kind: "done", batches: Math.ceil(79 / CHAT_LIMITS.batchSize) });
    expect(t.memory.queue).toEqual([]);
    const ids = t.memory.rows.map((r) => r.version);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe("cola: reservas caducadas, respuestas perdidas y fallos", () => {
  it("proceso interrumpido tras reservar: la reserva caduca y otra ejecución recupera el lote", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    await t.memory.store.claim(GAME, "proceso-muerto", CHAT_LIMITS.leaseSeconds, 25); // y no vuelve
    expect(await t.drain()).toMatchObject({ kind: "idle" });
    t.memory.advance(LEASE_MS + 1);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    // El proceso "muerto" ya no puede confirmar (ni con su token ni con su lote).
    expect(await t.memory.store.commit(GAME, "proceso-muerto", 4, {} as never, [], 60)).toBeNull();
  });

  it("respuesta perdida al reservar: la reserva quedó puesta; tras caducar se recupera sin duplicar", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    t.memory.loseResponse("claim");
    expect(await t.drain()).toMatchObject({ kind: "error" });
    expect(t.memory.chats.get(GAME)!.lockToken).not.toBeNull();
    t.memory.advance(LEASE_MS + 1);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(t.memory.rows).toHaveLength(2);
  });

  it("respuesta perdida al confirmar: lo confirmado no se repite", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    t.memory.loseResponse("commit");
    expect(await t.drain()).toMatchObject({ kind: "error" });
    expect(t.memory.rows).toHaveLength(2);
    expect(t.memory.queue).toEqual([]);
    expect(await t.drain()).toMatchObject({ kind: "idle" });
    expect(t.memory.rows).toHaveLength(2);
  });

  it("fallo durante la confirmación: nada cambia, se libera y el lote sigue pendiente", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    t.memory.fail("commit");
    expect(await t.drain()).toMatchObject({ kind: "error" });
    expect(t.memory.rows).toHaveLength(0);
    expect(t.memory.queue.map((q) => q.version)).toEqual([4]);
    expect(t.memory.chats.get(GAME)).toMatchObject({ lastVersion: 0, lockToken: null });
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
  });

  it("reserva caducada antes de confirmar: no se guarda nada y el lote sigue pendiente", async () => {
    let memoryRef: ReturnType<typeof createMemoryChatStore> | null = null;
    const slow: ChatWriter = {
      async write() {
        memoryRef!.advance(LEASE_MS + 1);
        return { text: "Texto tardío", source: "local" };
      },
    };
    const t = setup(slow);
    memoryRef = t.memory;
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "lease_expired" });
    expect(t.memory.rows).toHaveLength(0);
    expect(t.memory.queue).toHaveLength(1);
  });

  it("versión defectuosa: tras agotar los intentos se salta y deja pasar a las siguientes", async () => {
    const failing: ChatWriter = {
      async write({ utterance }) {
        if (utterance.speaker === "ai-pink") throw new Error("escritor caído para esta versión");
        return { text: `Frase de ${utterance.speaker} ${Math.random()}`, source: "local" };
      },
    };
    const t = setup(failing, failing);
    t.enqueue(10, [capture("ai-pink", "ai-purple")]); // falla siempre
    t.enqueue(20, [capture("ai-blue", "ai-green")]);
    for (let i = 0; i < CHAT_LIMITS.maxAttempts; i++) expect((await t.drain()).kind).toBe("error");
    expect(await t.drain()).toMatchObject({ kind: "done" });
    expect(t.versions()).toEqual([20]);
    expect(t.memory.queue).toEqual([]);
  });

  it("versión defectuosa en medio del lote: se confirma lo anterior y las siguientes no acumulan intentos", async () => {
    const failing: ChatWriter = {
      async write({ utterance }) {
        if (utterance.speaker === "ai-green") throw new Error("fallo solo en esta versión");
        return { text: `Frase ${utterance.speaker} ${utterance.trigger} ${Math.random()}`, source: "local" };
      },
    };
    const t = setup(failing, failing);
    t.enqueue(10, [capture("ai-pink", "ai-purple")]);
    t.enqueue(14, [capture("ai-green", "ai-blue")]); // falla siempre
    t.enqueue(22, [capture("ai-blue", "ai-pink")]);
    expect(await t.drain()).toMatchObject({ kind: "error", batches: 1 });
    expect(t.versions()).toEqual([10]); // lo anterior ya está confirmado
    expect(t.memory.queue.map((q) => [q.version, q.attempts])).toEqual([[14, 0], [22, 0]]);
    for (let i = 0; i < CHAT_LIMITS.maxAttempts; i++) expect((await t.drain()).kind).toBe("error");
    expect(t.memory.queue.map((q) => [q.version, q.attempts])).toEqual([[14, 3], [22, 0]]);
    expect(await t.drain()).toMatchObject({ kind: "done" });
    expect(t.versions()).toEqual([10, 22]);
  });

  it("versiones desfasadas (recuperación con retraso): se observan sin hablar; las recientes sí hablan", async () => {
    const t = setup();
    t.enqueue(4, [capture()]);
    t.enqueue(30, [capture("ai-blue", "ai-green")]);
    expect(await t.drain()).toMatchObject({ kind: "done" });
    expect(t.versions()).toEqual([30]);
  });
});

describe("victoria pendiente", () => {
  it("nunca se descarta por antigüedad", async () => {
    const t = setup();
    t.enqueue(4, victory("ai-green"));
    for (let v = 5; v <= 4 + CHAT_LIMITS.staleVersions * 3; v++) t.enqueue(v, [roll]);
    await t.drain();
    expect(t.memory.rows[0]).toMatchObject({ version: 4, trigger: "victory", character_id: "ai-green", seq: 0 });
  });

  it("ni por intentos agotados ni por datos dañados: se procesa en modo mínimo con la frase local", async () => {
    const failing: ChatWriter = { write: async () => { throw new Error("proveedor caído"); } };
    const t = setup(failing);
    t.enqueue(7, victory("ai-blue"), { basura: true } as never); // estado no válido
    for (let i = 0; i < CHAT_LIMITS.maxAttempts; i++) {
      t.memory.fail("commit"); // además, la BD falla en los primeros intentos
      expect((await t.drain()).kind).toBe("error");
    }
    expect(await t.drain()).toMatchObject({ kind: "done", published: 1 });
    const [message] = t.memory.rows;
    expect(message).toMatchObject({ version: 7, trigger: "victory", character_id: "ai-blue", source: "local" });
    expect(CHARACTERS[3].chat.lines.victory_win).toContain(message.text);
  });

  it("en el mismo lote que una versión defectuosa, la victoria se comenta igual", async () => {
    const failing: ChatWriter = {
      async write({ utterance }) {
        if (utterance.trigger === "capture") throw new Error("fallo");
        return { text: "¡Victoria!", source: "llm" };
      },
    };
    const t = setup(failing, failing);
    t.enqueue(4, [capture()]);
    t.enqueue(5, victory("ai-pink"));
    let result;
    do result = await t.drain(); while (result.kind === "error");
    expect(t.memory.rows.filter((r) => r.trigger === "victory" && r.seq === 0)).toHaveLength(1);
    expect(t.versions()).toEqual([5]);
  });

  it("aunque todas sus frases 'se repitan', la victoria tiene mensaje", async () => {
    const t = setup();
    t.enqueue(4, victory("ai-purple"));
    // Estado del director con todas las frases de victoria de Don Ernesto como recientes.
    await t.memory.store.claim(GAME, "prep", 10, 1);
    t.memory.chats.get(GAME)!.lockToken = null;
    t.memory.chats.get(GAME)!.lockedUntil = null;
    t.memory.chats.get(GAME)!.lockedThrough = null;
    t.memory.chats.get(GAME)!.directorState = {
      lastMessageVersion: 1, lastSpokeAt: {}, captures: [],
      recent: CHARACTERS[1].chat.lines.victory_win.map((text) => ({ speaker: "ai-purple", text })),
    };
    await t.drain();
    expect(t.memory.rows[0]).toMatchObject({ version: 4, trigger: "victory", character_id: "ai-purple" });
  });
});

/** ¿`text` es `line` con sus marcadores ({rival}, {count}/{Count}, {ritmo}) rellenados? */
function matchesLine(line: string, text: string): boolean {
  const names = Object.values(CHARACTER_NAMES).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = line
    .split(/(\{rival\}|\{count\}|\{Count\}|\{ritmo\})/)
    .map((part) =>
      part === "{rival}" ? `(?:${names})`
      : part === "{count}" ? "(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\\d+)"
      : part === "{Count}" ? "(?:Dos|Tres|Cuatro|Cinco|Seis|Siete|Ocho|Nueve|Diez|\\d+)"
      : part === "{ritmo}" ? "(?:seguidas|en poco tiempo)"
      : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(text);
}

/**
 * Coherencia con lo que pasó de verdad, calculada aparte de la implementación:
 * - Rachas: el número del texto es el número real de capturas en la ventana, y "seguidas" solo si
 *   no hubo ninguna otra captura entre medias.
 * - Tres seises sin ficha que devolver: el texto no habla de la casa.
 */
function checkCoherence(rows: { version: number; seq: number; trigger: string; character_id: string; text: string }[], eventsAt: Map<number, GameEvent[]>) {
  const log: { v: number; by: string; victim: string }[] = [];
  for (const [v, events] of [...eventsAt.entries()].sort((a, b) => a[0] - b[0])) {
    for (const e of events) if (e.type === "piece_captured") log.push({ v, by: e.playerId, victim: e.victimId });
    for (const r of rows.filter((x) => x.version === v && x.seq === 0)) {
      if (r.trigger === "capture_streak" || r.trigger === "bad_streak") {
        const role = r.trigger === "capture_streak" ? "by" : "victim";
        const window = log.filter((c) => v - c.v < CHAT_LIMITS.streakWindow);
        const count = window.filter((c) => c[role] === r.character_id).length;
        let run = 0;
        for (let i = window.length - 1; i >= 0 && window[i][role] === r.character_id; i--) run++;
        const words = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];
        // Desde "dos" (una racha tiene al menos 2): "una" sería el artículo, no un número.
        const said = words.findIndex((w, n) => n >= 2 && new RegExp(`\\b${w}\\b`, "i").test(r.text));
        if (said !== -1) expect(said, r.text).toBe(count);
        if (/seguidas/.test(r.text)) expect(run, r.text).toBe(count);
        if (/en poco tiempo/.test(r.text)) expect(run, r.text).not.toBe(count);
      }
      if (r.trigger === "third_six") {
        const penalty = events.find((e) => e.type === "third_six_penalty");
        if (penalty?.type === "third_six_penalty" && penalty.pieceIndex === null) expect(r.text).not.toMatch(/casa/i);
      }
    }
  }
}

describe("partidas completas con ejecuciones concurrentes, interrupciones y fallos", () => {
  /**
   * Juega una partida real (motor + IA). Tras cada versión (encolada de forma atómica), lanza el
   * procesador SIN esperarlo (como after), a veces varios a la vez, a veces nunca (after perdido),
   * con fallos y respuestas perdidas al azar e interrupciones (reservas abandonadas). Al terminar,
   * "espectadores" llaman al procesador (como el GET de mensajes) hasta vaciar la cola.
   */
  async function chaos(seed: number) {
    const memory = createMemoryChatStore();
    const random = createSeededRandom(seed);
    const chaosRandom = createSeededRandom(seed * 7919);
    let dieSeed = seed;
    const die = () => 1 + Math.floor((((dieSeed = (dieSeed * 16807) % 2147483647) - 1) / 2147483646) * 6);
    let tokens = 0;
    const local = createLocalWriter(random);
    const deps: ChatDeps = { store: memory.store, writer: local, fallbackWriter: local, random, newToken: () => `t${++tokens}` };
    let state = createGame([...CHARACTER_IDS]);
    let version = 1;
    const eventsAt = new Map<number, GameEvent[]>();
    const running: Promise<unknown>[] = [];

    while (state.status === "playing") {
      const result = applyAction(state, decideAction(state, die, random));
      if (!result.ok) throw new Error(result.error);
      state = result.state;
      version++;
      eventsAt.set(version, result.events);
      memory.enqueue(GAME, version, result.events, state); // misma transacción que el avance

      const r = chaosRandom();
      if (r < 0.02) memory.fail("commit");
      else if (r < 0.04) memory.loseResponse("commit");
      else if (r < 0.05) memory.loseResponse("claim");
      else if (r < 0.06) await memory.store.claim(GAME, `muerto-${version}`, CHAT_LIMITS.leaseSeconds, 25); // interrupción
      memory.advance(1200); // ritmo de la partida
      if (chaosRandom() < 0.9) running.push(drainChat(GAME, deps)); // a veces after() no llega a ejecutarse
      if (chaosRandom() < 0.2) running.push(drainChat(GAME, deps)); // a veces coinciden dos
      if (chaosRandom() < 0.3) await Promise.all(running.splice(0));
    }
    await Promise.all(running);
    // Partida terminada: ya no llegan avances; los espectadores consultan y ponen en marcha el procesador.
    for (let i = 0; i < 50 && memory.queue.length > 0; i++) {
      memory.advance(LEASE_MS + 1);
      await drainChat(GAME, deps);
    }
    return { memory, final: state, version, eventsAt };
  }

  it("no se pierde la victoria, no hay duplicados y se cumplen pausas, réplicas y límites", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { memory, final, version, eventsAt } = await chaos(seed);
      const rows = memory.rows;
      expect(memory.queue).toEqual([]);
      expect(memory.chats.get(GAME)!.lastVersion).toBe(version);
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.length).toBeLessThanOrEqual(CHAT_LIMITS.maxMessagesPerGame);
      expect(new Set(rows.map((r) => `${r.version}:${r.seq}`)).size).toBe(rows.length);

      const victoryRows = rows.filter((r) => r.trigger === "victory" && r.seq === 0);
      expect(victoryRows).toHaveLength(1);
      expect(victoryRows[0].character_id).toBe(final.ranking[0]);

      // Orden: los ids crecen con la versión.
      const byId = [...rows].sort((a, b) => a.id - b.id).map((r) => r.version);
      expect(byId).toEqual([...byId].sort((a, b) => a - b));

      const exchanges = [...new Set(rows.map((r) => r.version))];
      for (const v of exchanges) {
        const msgs = rows.filter((r) => r.version === v);
        expect(msgs.length).toBeLessThanOrEqual(2);
        if (msgs[1]) expect(msgs[1].character_id).not.toBe(msgs[0].character_id);
        const types = eventsAt.get(v)!.map((e) => e.type);
        if (msgs[0].trigger !== "ambient") {
          expect(types.some((x) => ["piece_captured", "third_six_penalty", "player_finished", "piece_reached_goal"].includes(x))).toBe(true);
        }
      }
      const exempt = (v: number) => rows.some((r) => r.version === v && r.trigger === "victory") || v === version;
      for (let i = 1; i < exchanges.length; i++) {
        if (!exempt(exchanges[i])) expect(exchanges[i] - exchanges[i - 1]).toBeGreaterThanOrEqual(CHAT_LIMITS.globalCooldown);
      }
      for (const id of CHARACTER_IDS) {
        const mine = rows.filter((r) => r.character_id === id).map((r) => r.version);
        for (let i = 1; i < mine.length; i++) {
          if (!exempt(mine[i])) expect(mine[i] - mine[i - 1]).toBeGreaterThanOrEqual(CHAT_LIMITS.characterCooldown);
        }
      }
      for (let i = 0; i < rows.length; i++) {
        for (const prev of rows.slice(Math.max(0, i - CHAT_LIMITS.recentTexts), i)) {
          if (rows[i].trigger !== "victory") expect(similarity(rows[i].text, prev.text)).toBeLessThan(CHAT_LIMITS.maxSimilarity);
        }
      }
      for (const r of rows) {
        // Cada texto es una frase del propio personaje con sus marcadores rellenados.
        const own = Object.values(CHARACTERS.find((c) => c.id === r.character_id)!.chat.lines).flat();
        expect(own.some((line) => matchesLine(line, r.text)), r.text).toBe(true);
      }
      checkCoherence(rows, eventsAt);
    }
  });
});

describe("proporción de mensajes (B4)", () => {
  it("las capturas no dominan el chat, pero se siguen comentando; la victoria, siempre", async () => {
    let total = 0;
    let captureRelated = 0;
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const memory = createMemoryChatStore();
      const random = createSeededRandom(seed);
      let dieSeed = seed;
      const die = () => 1 + Math.floor((((dieSeed = (dieSeed * 16807) % 2147483647) - 1) / 2147483646) * 6);
      let tokens = 0;
      const local = createLocalWriter(random);
      const deps: ChatDeps = { store: memory.store, writer: local, fallbackWriter: local, random, newToken: () => `t${++tokens}` };
      let state = createGame([...CHARACTER_IDS]);
      let version = 1;
      while (state.status === "playing") {
        const result = applyAction(state, decideAction(state, die, random));
        if (!result.ok) throw new Error(result.error);
        state = result.state;
        memory.enqueue(GAME, ++version, result.events, state);
        await drainChat(GAME, deps);
      }
      const triggers = memory.rows.map((r) => r.trigger);
      expect(triggers.filter((t) => t === "capture" || t === "capture_streak" || t === "bad_streak").length).toBeGreaterThan(3);
      expect(triggers).toContain("victory");
      total += triggers.length;
      captureRelated += triggers.filter((t) => t === "capture" || t === "capture_streak" || t === "bad_streak").length;
    }
    // Antes (0,8/0,95/0,9) eran el 63 %; ahora en torno al 51 %.
    expect(captureRelated / total).toBeLessThan(0.56);
    expect(total / 8).toBeGreaterThan(25); // el chat no se queda mudo
  });
});

describe("reserva de 30 s con un escritor principal lento o que falla (preparación de 8.2b)", () => {
  const LEASE = CHAT_LIMITS.leaseSeconds * 1000;
  /**
   * Capturas en las que siempre hablan dos (captor y víctima) sin chocar con las pausas: parejas
   * alternas y separadas ≥ 8 versiones del mismo personaje, todas a menos de 15 de la última.
   */
  const pairs = [["ai-pink", "ai-purple"], ["ai-green", "ai-blue"]];
  const enqueueCaptures = (t: ReturnType<typeof setup>, versions: number[]) =>
    versions.forEach((v, i) => t.enqueue(v, [capture(pairs[i % 2][0], pairs[i % 2][1])]));
  /** Textos bien distintos entre sí (para que la antirrepetición no los descarte). */
  const TEXTS = [
    "El dado manda y yo obedezco sin rechistar.", "Qué jugada tan bonita, casi me emociono.", "Hoy las fichas vuelan por el tablero.",
    "Paciencia y estrategia, mis queridos rivales.", "No pienso rendirme todavía, ni de broma.", "Eso ha dolido más de lo que parece.",
    "Una captura limpia, de manual absoluto.", "Me lo apunto para la revancha de mañana.", "Vaya racha de suerte llevamos aquí.",
    "Cada casilla cuenta, no lo olvidéis nunca.", "Menudo susto me acabas de dar, amigo.", "Sigamos, que la tarde es muy larga.",
  ];

  /** Escritor principal que "tarda" `ms` en el reloj de la BD y responde con un texto único. */
  function slowWriter(t: { memory: ReturnType<typeof createMemoryChatStore> }, ms: number) {
    const calls: { version?: number; timeoutMs?: number; at: number }[] = [];
    let n = 0;
    const writer: ChatWriter = {
      async write(request) {
        calls.push({ timeoutMs: request.timeoutMs, at: t.memory.clock() });
        t.memory.advance(ms);
        return { text: TEXTS[n++ % TEXTS.length], source: "llm" };
      },
    };
    return { writer, calls };
  }

  it("un principal de 4 s por mensaje ya no deja la cola bloqueada: cada reserva avanza y confirma a tiempo", async () => {
    const holder = { memory: createMemoryChatStore() };
    const slow = slowWriter(holder, 4_000);
    const t = setup(slow.writer);
    holder.memory = t.memory;
    t.deps.now = t.memory.clock;
    enqueueCaptures(t, [2, 5, 11, 14]);

    // 4 versiones × 2 intervenciones × 4 s = 32 s > 30 s de reserva. La 1.ª reserva hace la v2 (0–8 s)
    // y la v5 (8–16 s); a los 16 s ya pasó la mitad: confirma y la siguiente reserva hace v11 y v14.
    const result = await t.drain();
    expect(result).toMatchObject({ kind: "done", batches: 2, published: 8 });
    expect(t.memory.queue).toEqual([]);
    expect(t.versions()).toEqual([2, 5, 11, 14]);
    // Sin llamadas repetidas: una por mensaje publicado, y todas del principal.
    expect(slow.calls).toHaveLength(8);
    expect(t.memory.rows.every((r) => r.source === "llm")).toBe(true);
  });

  it("cada llamada tiene un tiempo máximo que deja siempre el margen para confirmar su reserva", async () => {
    const holder = { memory: createMemoryChatStore() };
    const slow = slowWriter(holder, 7_000);
    const t = setup(slow.writer);
    holder.memory = t.memory;
    t.deps.now = t.memory.clock;
    // Inicio de cada reserva (según el reloj del procesador, tras la respuesta).
    const leaseStarts: number[] = [];
    const claim = t.memory.store.claim.bind(t.memory.store);
    t.deps.store = { ...t.memory.store, claim: async (...args: Parameters<typeof claim>) => {
      const batch = await claim(...args);
      if (batch) leaseStarts.push(t.memory.clock());
      return batch;
    } };
    enqueueCaptures(t, [2, 5, 11]);
    await t.drain();
    expect(t.memory.queue).toEqual([]);
    expect(leaseStarts.length).toBeGreaterThan(1); // las llamadas de 7 s obligan a repartir en varias reservas
    for (const c of slow.calls) {
      const start = Math.max(...leaseStarts.filter((s0) => s0 <= c.at));
      expect(c.timeoutMs!).toBeGreaterThanOrEqual(CHAT_LIMITS.minWriterMs);
      expect(c.timeoutMs!).toBeLessThanOrEqual(CHAT_LIMITS.writerTimeoutMs);
      expect(c.at + c.timeoutMs!).toBeLessThanOrEqual(start + LEASE - CHAT_LIMITS.commitMarginMs);
    }
  });

  it("si el principal agota su tiempo: se aborta, se usa el escritor local y no se repite la llamada", async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const hanging: ChatWriter = {
      write(request) {
        calls++;
        signal = request.signal;
        return new Promise(() => {}); // nunca responde
      },
    };
    const t = setup(hanging);
    const timers: number[] = [];
    t.deps.setTimeout = (fn, ms) => {
      timers.push(ms);
      queueMicrotask(fn); // el plazo vence enseguida
      return 0;
    };
    t.deps.clearTimeout = () => {};
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(2); // una por intervención, sin reintentos
    expect(timers.every((ms) => ms <= CHAT_LIMITS.writerTimeoutMs)).toBe(true);
    expect(t.memory.rows.every((r) => r.source === "local")).toBe(true);
  });

  it("si el principal falla, se usa el escritor local", async () => {
    const failing: ChatWriter = { write: async () => { throw new Error("proveedor caído o cuota agotada"); } };
    const t = setup(failing);
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(t.memory.rows.map((r) => r.source)).toEqual(["local", "local"]);
  });

  it("si casi no queda reserva, ni se llama al principal: directamente el local", async () => {
    let calls = 0;
    const counting: ChatWriter = { write: async () => (calls++, { text: "nunca", source: "llm" }) };
    const t = setup(counting);
    let tick = 0;
    // 1.ª lectura: inicio de la reserva; después, a 200 ms del margen de confirmación.
    t.deps.now = () => (tick++ === 0 ? 0 : LEASE - CHAT_LIMITS.commitMarginMs - 200);
    t.enqueue(4, [capture()]);
    await t.drain();
    expect(calls).toBe(0);
    expect(t.memory.rows.map((r) => r.source)).toEqual(["local", "local"]);
  });

  it("la victoria se escribe con el escritor local aunque el principal falle o tarde demasiado", async () => {
    const failing: ChatWriter = { write: async () => { throw new Error("LLM caído"); } };
    const t = setup(failing);
    t.enqueue(9, victory("ai-blue"));
    await t.drain();
    expect(t.memory.rows[0]).toMatchObject({ version: 9, trigger: "victory", character_id: "ai-blue", source: "local" });
    expect(CHARACTERS[3].chat.lines.victory_win).toContain(t.memory.rows[0].text);
  });
});

describe("tiempo máximo del escritor principal: temporizador, reserva local y margen (preparación de 8.2b)", () => {
  const LEASE = CHAT_LIMITS.leaseSeconds * 1000;

  /** Temporizadores registrados: cuáles se crean, cuáles se limpian y cuáles llegan a vencer. */
  function recordingTimers(t: ReturnType<typeof setup>, { fire = false, advance = false } = {}) {
    const timers = new Map<number, { ms: number; cleared: boolean; fired: boolean; fn: () => void }>();
    let next = 1;
    t.deps.setTimeout = (fn, ms) => {
      const id = next++;
      timers.set(id, { ms, cleared: false, fired: false, fn });
      if (fire) {
        // Vence en una tarea posterior (como un temporizador real): antes se procesan las promesas
        // ya resueltas, así que una respuesta a tiempo lo limpia y no llega a vencer.
        setTimeout(() => {
          const timer = timers.get(id)!;
          if (timer.cleared) return;
          if (advance) t.memory.advance(ms); // el escritor "estuvo colgado" todo el plazo
          timer.fired = true;
          fn();
        }, 0);
      }
      return id;
    };
    t.deps.clearTimeout = (h) => {
      const timer = timers.get(h as number);
      if (timer) timer.cleared = true;
    };
    return timers;
  }

  /** Escritor de reserva que cuenta sus llamadas (envuelve al local). */
  function countingLocal() {
    const local = createLocalWriter(createSeededRandom(2));
    const counter = { calls: 0 };
    const writer: ChatWriter = { write: (request) => (counter.calls++, local.write(request)) };
    return { writer, counter };
  }

  it("si el principal responde antes del plazo, su temporizador se limpia y nunca vence", async () => {
    const replies = ["¡Menuda jugada acabo de hacer, señores!", "Esto no se queda así, te lo aseguro."];
    let n = 0;
    const ok: ChatWriter = { write: async () => ({ text: replies[n++], source: "llm" }) };
    const t = setup(ok);
    const timers = recordingTimers(t);
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(timers.size).toBe(2); // una llamada por intervención
    for (const timer of timers.values()) expect(timer).toMatchObject({ cleared: true, fired: false });
    expect(t.memory.rows.map((r) => r.source)).toEqual(["llm", "llm"]);
  });

  it("si el principal falla antes del plazo, el temporizador se limpia y el local se usa una sola vez por intervención", async () => {
    const failing: ChatWriter = { write: async () => { throw new Error("cuota agotada"); } };
    const fallback = countingLocal();
    const t = setup(failing, fallback.writer);
    const timers = recordingTimers(t);
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    for (const timer of timers.values()) expect(timer).toMatchObject({ cleared: true, fired: false });
    expect(fallback.counter.calls).toBe(2);
    expect(t.memory.rows.map((r) => r.source)).toEqual(["local", "local"]);
  });

  it("también si el principal lanza el error de forma síncrona (sin devolver una promesa)", async () => {
    const throwsSync: ChatWriter = { write: () => { throw new Error("fallo al preparar la petición"); } };
    const fallback = countingLocal();
    const t = setup(throwsSync, fallback.writer);
    const timers = recordingTimers(t);
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(timers.size).toBe(2);
    for (const timer of timers.values()) expect(timer).toMatchObject({ cleared: true, fired: false });
    expect(fallback.counter.calls).toBe(2);
  });

  it("si vence el plazo: se aborta la llamada y el local se usa una sola vez (el temporizador ya venció)", async () => {
    let signal: AbortSignal | undefined;
    const hanging: ChatWriter = { write: (request) => ((signal = request.signal), new Promise(() => {})) };
    const fallback = countingLocal();
    const t = setup(hanging, fallback.writer);
    const timers = recordingTimers(t, { fire: true });
    t.enqueue(4, [capture()]);
    expect(await t.drain()).toMatchObject({ kind: "done", published: 2 });
    expect(signal?.aborted).toBe(true);
    for (const timer of timers.values()) expect(timer.fired).toBe(true);
    expect(fallback.counter.calls).toBe(2);
  });

  it("si también falla el local, el error se propaga: lo anterior se confirma y esa versión queda pendiente", async () => {
    const failing: ChatWriter = { write: async () => { throw new Error("LLM caído"); } };
    const local = createLocalWriter(createSeededRandom(3));
    let fallbackCalls = 0;
    const brokenForGreen: ChatWriter = {
      write(request) {
        fallbackCalls++;
        if (request.utterance.speaker === "ai-green") throw new Error("frases dañadas");
        return local.write(request);
      },
    };
    const t = setup(failing, brokenForGreen);
    recordingTimers(t);
    t.enqueue(10, [capture("ai-pink", "ai-purple")]);
    t.enqueue(14, [capture("ai-green", "ai-blue")]); // su escritor local falla
    t.enqueue(20, [capture("ai-blue", "ai-pink")]);
    const result = await t.drain();
    expect(result.kind).toBe("error");
    expect((result as { error: Error }).error.message).toBe("frases dañadas");
    expect(t.versions()).toEqual([10]); // lo anterior, confirmado
    expect(t.memory.queue.map((q) => q.version)).toEqual([14, 20]); // la versión que falla, pendiente (y las siguientes)
    expect(t.memory.chats.get(GAME)).toMatchObject({ lastVersion: 10, lockToken: null });
    expect(fallbackCalls).toBe(3); // 2 de la v10 + 1 de la v14 (se detiene en el primer fallo, sin reintentar)
  });

  it("peor caso: el principal agota los dos plazos de la última versión y aun así se confirma dentro del margen", async () => {
    // v2: dos llamadas de 7,45 s (14,9 s, justo antes de la mitad). v5 empieza a los 14,9 s y su principal
    // se cuelga: 1.ª llamada hasta 22,9 s; 2.ª, con el tiempo que queda hasta el margen (27 s). Local: al instante.
    const t = setup();
    const confirmedAt: number[] = [];
    let calls = 0;
    const principal: ChatWriter = {
      write: () => {
        calls++;
        if (calls <= 2) {
          t.memory.advance(7_450);
          return Promise.resolve({ text: calls === 1 ? "Primera respuesta generada, bien larga." : "Segunda frase distinta para la réplica.", source: "llm" as const });
        }
        return new Promise(() => {}); // colgado hasta que vence su plazo
      },
    };
    t.deps.writer = principal;
    t.deps.now = t.memory.clock;
    recordingTimers(t, { fire: true, advance: true });
    const commit = t.memory.store.commit.bind(t.memory.store);
    t.deps.store = { ...t.memory.store, commit: async (...args: Parameters<typeof commit>) => (confirmedAt.push(t.memory.clock()), commit(...args)) };
    t.enqueue(2, [capture("ai-pink", "ai-purple")]);
    t.enqueue(5, [capture("ai-green", "ai-blue")]);

    expect(await t.drain()).toMatchObject({ kind: "done", published: 4 });
    expect(confirmedAt).toHaveLength(1);
    // Confirma justo al empezar el margen: los 3 s de margen quedan intactos (el local no consume tiempo).
    expect(confirmedAt[0]).toBeLessThanOrEqual(LEASE - CHAT_LIMITS.commitMarginMs);
    expect(confirmedAt[0]).toBe(14_900 + 8_000 + 4_100); // 22,9 s + lo que quedaba hasta el margen = 27 s
    expect(t.memory.rows.map((r) => [r.version, r.source])).toEqual([[2, "llm"], [2, "llm"], [5, "local"], [5, "local"]]);
  });
});
