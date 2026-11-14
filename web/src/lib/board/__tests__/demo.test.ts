import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCharacter } from "@/lib/game/characters";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { applyAction, createGame, getAvailableMoves } from "@/lib/engine";
import { createLocalWriter } from "@/lib/chat/writer";
import {
  DEMO_LOG_SIZE,
  DEMO_SEED,
  DEMO_START_ACTIONS,
  createDemoMatch,
  createShowcaseState,
  newDemoMatch,
  nextDemoAction,
  rollDemoAction,
  seededDemoRandom,
  stepDemo,
} from "../demo";

describe("demo de /tablero: partida inicial", () => {
  it("es determinista: la misma semilla da el mismo estado, las mismas jugadas y los mismos mensajes", async () => {
    const [a, b] = await Promise.all([createDemoMatch(), createDemoMatch()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Otra semilla, otra partida.
    expect(JSON.stringify((await createDemoMatch(DEMO_SEED + 1)).state)).not.toBe(JSON.stringify(a.state));
  });

  it("es una partida real de los cuatro personajes, avanzada y en curso", async () => {
    const match = await createDemoMatch();
    const { state } = match;
    expect(state.players.map((p) => p.id)).toEqual([...CHARACTER_IDS]);
    expect(state.status).toBe("playing");
    expect(match.version).toBe(DEMO_START_ACTIONS + 1);
    // Todos tienen alguna ficha fuera de casa, y hay fichas en el pasillo o en la meta.
    for (const p of state.players) expect(p.pieces.some((x) => x.steps >= 0), p.id).toBe(true);
    expect(state.players.some((p) => p.pieces.some((x) => x.state === "final" || x.state === "finished"))).toBe(true);
    // Jugadas con historia y la última acción con sus eventos.
    expect(match.log.length).toBeGreaterThan(9);
    expect(match.log.length).toBeLessThanOrEqual(DEMO_LOG_SIZE);
    expect(match.lastAction).not.toBeNull();
    expect(match.lastEvents.length).toBeGreaterThan(0);
  });

  it("el chat responde a acontecimientos reales, con frases del catálogo de cada personaje", async () => {
    const match = await createDemoMatch();
    expect(match.messages.length).toBeGreaterThanOrEqual(8);
    expect(new Set(match.messages.map((m) => m.characterId)).size).toBeGreaterThanOrEqual(3);
    expect(match.messages.some((m) => m.trigger === "capture" || m.trigger === "capture_streak" || m.trigger === "bad_streak")).toBe(true);
    // Ids únicos y crecientes; orden versión → seq; nunca de versiones futuras.
    const ids = match.messages.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of match.messages) expect(m.version).toBeLessThanOrEqual(match.version);
    // Cada texto sale de las frases de su personaje para ese tipo de intervención (no hay relleno).
    for (const m of match.messages) {
      const lines = Object.values(getCharacter(m.characterId)!.chat.lines).flat();
      const pattern = (line: string) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{(rival|count|Count|ritmo)\\\}/g, ".+")}$`, "u");
      expect(lines.some((line) => pattern(line).test(m.text)), `${m.characterId}: ${m.text}`).toBe(true);
    }
  });
});

describe("demo de /tablero: continuar la partida", () => {
  it("cada acción la decide la IA del juego y la valida el motor", async () => {
    const random = seededDemoRandom(99);
    let match = await createDemoMatch();
    for (let i = 0; i < 60 && match.state.status === "playing"; i++) {
      const action = nextDemoAction(match.state, random);
      if (action.type === "move") expect(getAvailableMoves(match.state)).toContain(action.pieceIndex);
      const expected = applyAction(match.state, action);
      expect(expected.ok).toBe(true);
      const next = await stepDemo(match, action, random);
      expect(next).not.toBeNull();
      expect(next!.state).toEqual(expected.ok && expected.state);
      expect(next!.version).toBe(match.version + 1);
      match = next!;
    }
  });

  it("una acción ilegal no se aplica, y stepDemo nunca modifica la partida que recibe", async () => {
    const match = newDemoMatch();
    const before = JSON.stringify(match);
    const random = seededDemoRandom(1);
    expect(await stepDemo(match, { type: "move", playerId: match.state.turn, pieceIndex: 0 }, random)).toBeNull();
    const rolled = await stepDemo(match, rollDemoAction(match.state, random), random);
    expect(rolled!.lastAction).toMatchObject({ type: "roll", playerId: "ai-pink" });
    expect(JSON.stringify(match)).toBe(before);
  });

  it("una partida completa hasta la victoria: el ganador habla y el chat no supera su límite", async () => {
    const random = seededDemoRandom(3);
    let match = newDemoMatch();
    for (let i = 0; i < 4000 && match.state.status === "playing"; i++) {
      match = (await stepDemo(match, nextDemoAction(match.state, random), random))!;
    }
    expect(match.state.status).toBe("finished");
    const winner = match.state.ranking[0];
    expect(match.messages.some((m) => m.trigger === "victory" && m.characterId === winner)).toBe(true);
    expect(match.messages.length).toBeLessThanOrEqual(60);
  });

  it("«Partida nueva» y «Ejemplo» usan los cuatro personajes", () => {
    expect(newDemoMatch().state.players.map((p) => p.id)).toEqual(createGame([...CHARACTER_IDS]).players.map((p) => p.id));
    expect(createShowcaseState().players.map((p) => p.id)).toEqual([...CHARACTER_IDS]);
  });
});

describe("demo de /tablero: aislamiento", () => {
  it("la demo no importa nada de servidor, Supabase, la API, el LLM ni el directo", () => {
    for (const file of ["src/lib/board/demo.ts", "src/components/board/BoardDemo.tsx"]) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].filter((m) => !m[1]).map((m) => m[2]);
      for (const path of imports) {
        expect(path, `${file}: ${path}`).not.toMatch(/supabase|repository|schedule|store|\/load|\/llm|gatewayWriter|liveController|useLiveGame|realtime|security|\/api\/|server-only/);
      }
    }
  });

  it("el escritor del chat es el local (sin red): no necesita fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("La demo no debe usar la red");
    }) as typeof fetch;
    try {
      expect((await createDemoMatch(DEMO_SEED, 120)).messages.length).toBeGreaterThan(0);
      expect(typeof createLocalWriter).toBe("function");
    } finally {
      globalThis.fetch = original;
    }
  });
});
