import { describe, expect, it } from "vitest";
import { createGame, type GameEvent, type GameState } from "@/lib/engine";
import { createSeededRandom } from "@/lib/game/ai";
import { CHARACTERS, CHARACTER_IDS } from "@/lib/game/characters";
import { CHAT_LIMITS } from "../config";
import { ambientCandidates, initialDirectorState, isChatCandidate, planChat, recordPublished, streakOf, type Random } from "../director";
import { DirectorStateSchema, type DirectorState } from "../schemas";

const [BRAVA, ERNESTO, PILAR, CHISPA] = CHARACTER_IDS;
const game = (patch: Partial<GameState> = {}): GameState => ({ ...createGame([...CHARACTER_IDS]), ...patch });
/** Azar fijo: 0 = la opción más probable siempre "sale". */
const always: Random = () => 0;
const never: Random = () => 0.999;

const capture = (by: string, victim: string): GameEvent => ({ type: "piece_captured", playerId: by, victimId: victim, victimPieceIndex: 0, cell: 30 });
const routine: GameEvent[] = [
  { type: "dice_rolled", playerId: BRAVA, value: 3 },
  { type: "turn_changed", playerId: CHISPA },
];

function plan(events: GameEvent[], opts: { version?: number; director?: Partial<DirectorState>; messageCount?: number; state?: GameState; random?: Random } = {}) {
  return planChat(
    {
      version: opts.version ?? 101,
      events,
      state: opts.state ?? game(),
      messageCount: opts.messageCount ?? 0,
      director: { ...initialDirectorState(), ...opts.director },
    },
    opts.random ?? always,
  );
}

describe("selección de acontecimientos", () => {
  it("las tiradas y los movimientos normales no generan mensajes (ni consultan la BD)", () => {
    expect(isChatCandidate(routine, 101)).toBe(false);
    expect(plan(routine).utterances).toEqual([]);
    expect(isChatCandidate([capture(BRAVA, CHISPA)], 101)).toBe(true);
    expect(isChatCandidate(routine, 110)).toBe(true); // valoración de ambiente cada 10 versiones
  });

  it("captura: habla quien captura o la víctima, y la réplica la da la otra parte (nunca uno mismo)", () => {
    const { utterances } = plan([capture(BRAVA, ERNESTO)]);
    expect(utterances[0]).toMatchObject({ speaker: BRAVA, kind: "capture_boast", rival: ERNESTO, trigger: "capture", important: true });
    expect(utterances[1]).toMatchObject({ speaker: ERNESTO, kind: "capture_lament", rival: BRAVA, replyTo: 0 });
    for (let seed = 1; seed <= 200; seed++) {
      const result = plan([capture(CHISPA, PILAR)], { random: createSeededRandom(seed) }).utterances;
      expect(result.length).toBeLessThanOrEqual(2);
      for (const u of result) expect([CHISPA, PILAR]).toContain(u.speaker);
      if (result.length === 2) expect(result[1].speaker).not.toBe(result[0].speaker);
    }
  });

  it("victoria: el ganador habla siempre y se salta las pausas", () => {
    const events: GameEvent[] = [{ type: "player_finished", playerId: PILAR, place: 1 }];
    const director = { lastMessageVersion: 100, lastSpokeAt: { [PILAR]: 100 } };
    const { utterances } = plan(events, { director, random: never });
    expect(utterances).toEqual([{ speaker: PILAR, kind: "victory_win", trigger: "victory", rival: null, replyTo: null, important: true }]);
    const withReply = plan(events, { director }).utterances;
    expect(withReply[1]).toMatchObject({ kind: "victory_reply", rival: PILAR, replyTo: 0 });
    expect(withReply[1].speaker).not.toBe(PILAR);
  });

  it("tercer seis: el afectado se lamenta o alguien se burla, y el otro replica", () => {
    const events: GameEvent[] = [{ type: "third_six_penalty", playerId: ERNESTO, pieceIndex: 2 }];
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const u = plan(events, { random: createSeededRandom(seed) }).utterances;
      if (u.length === 0) continue;
      kinds.add(u[0].kind);
      expect(u[0].kind === "third_six_self" ? u[0].speaker === ERNESTO : u[0].rival === ERNESTO).toBe(true);
      if (u[1]) expect(u[1].speaker).not.toBe(u[0].speaker);
    }
    expect(kinds).toEqual(new Set(["third_six_self", "third_six_tease"]));
  });

  it("rachas: dos capturas seguidas del mismo → racha; dos veces víctima seguidas → mala racha (con sus datos)", () => {
    const streak = plan([capture(BRAVA, CHISPA)], { director: { captures: [{ v: 80, by: BRAVA, victim: PILAR }] } });
    expect(streak.utterances[0]).toMatchObject({ speaker: BRAVA, kind: "streak_boast", trigger: "capture_streak", streak: { count: 2, consecutive: true } });
    const bad = plan([capture(ERNESTO, CHISPA)], { director: { captures: [{ v: 90, by: PILAR, victim: CHISPA }] } });
    expect(bad.utterances[0]).toMatchObject({ speaker: CHISPA, kind: "streak_lament", trigger: "bad_streak", streak: { count: 2, consecutive: true } });
    // Fuera de la ventana no cuenta.
    const old = plan([capture(BRAVA, CHISPA)], { director: { captures: [{ v: 101 - CHAT_LIMITS.streakWindow, by: BRAVA, victim: PILAR }] } });
    expect(old.utterances[0].trigger).toBe("capture");
    expect(old.director.captures).toEqual([{ v: 101, by: BRAVA, victim: CHISPA }]);
  });

  it("rachas: número real de capturas y consecutividad solo si no hubo otras capturas entre medias", () => {
    const c = (v: number, by: string, victim: string) => ({ v, by, victim });
    // 2 de Brava, pero con otra captura entre medias: no es racha (ni 3 en total ni 2 seguidas).
    expect(streakOf([c(70, BRAVA, PILAR), c(80, CHISPA, ERNESTO), c(101, BRAVA, CHISPA)], BRAVA, "by")).toBeNull();
    expect(plan([capture(BRAVA, CHISPA)], { director: { captures: [c(70, BRAVA, PILAR), c(80, CHISPA, ERNESTO)] } }).utterances[0].trigger).toBe("capture");
    // 3 en la ventana, no seguidas → racha de 3 "en poco tiempo".
    const three = [c(50, BRAVA, PILAR), c(60, CHISPA, ERNESTO), c(70, BRAVA, ERNESTO), c(80, PILAR, CHISPA), c(101, BRAVA, CHISPA)];
    expect(streakOf(three, BRAVA, "by")).toEqual({ count: 3, consecutive: false });
    // 3 seguidas → racha de 3 "seguidas" (no "dos").
    expect(streakOf([c(80, CHISPA, PILAR), c(90, BRAVA, PILAR), c(95, BRAVA, ERNESTO), c(101, BRAVA, CHISPA)], BRAVA, "by")).toEqual({ count: 3, consecutive: true });
    // 4 en total, solo las 2 últimas seguidas → 4 "en poco tiempo".
    expect(streakOf([c(50, BRAVA, PILAR), c(60, BRAVA, PILAR), c(70, CHISPA, ERNESTO), c(90, BRAVA, PILAR), c(101, BRAVA, CHISPA)], BRAVA, "by")).toEqual({ count: 4, consecutive: false });
    // Como víctima, igual.
    expect(streakOf([c(80, BRAVA, CHISPA), c(90, PILAR, ERNESTO), c(101, PILAR, CHISPA)], CHISPA, "victim")).toBeNull();
    expect(streakOf([c(80, BRAVA, CHISPA), c(101, PILAR, CHISPA)], CHISPA, "victim")).toEqual({ count: 2, consecutive: true });
    // La réplica de una racha no lleva datos de racha (habla de la captura, no del recuento).
    const withReply = plan([capture(BRAVA, CHISPA)], { director: { captures: [c(90, BRAVA, PILAR)] } }).utterances;
    expect(withReply[1]?.streak).toBeUndefined();
  });

  it("ambiente: quien ya terminó no comenta ni es el rival del comentario", () => {
    const state = game({ ranking: [PILAR] });
    const quiet = { lastMessageVersion: 10, lastSpokeAt: {} };
    for (let seed = 1; seed <= 200; seed++) {
      for (const u of plan(routine, { version: 100, state, director: quiet, random: createSeededRandom(seed) }).utterances) {
        expect(u.speaker).not.toBe(PILAR);
        expect(u.rival).not.toBe(PILAR);
      }
    }
  });

  it("meta y puesto final; el último comentario de la partida se salta las pausas", () => {
    expect(plan([{ type: "piece_reached_goal", playerId: CHISPA, pieceIndex: 1 }]).utterances[0]).toMatchObject({ speaker: CHISPA, kind: "goal" });
    const end: GameEvent[] = [
      { type: "player_finished", playerId: ERNESTO, place: 3 },
      { type: "game_finished", winner: PILAR, ranking: [PILAR, BRAVA, ERNESTO, CHISPA] },
    ];
    const state = game({ ranking: [PILAR, BRAVA, ERNESTO, CHISPA] });
    const { utterances } = plan(end, { state, director: { lastMessageVersion: 100, lastSpokeAt: { [ERNESTO]: 100 } } });
    expect(utterances[0]).toMatchObject({ speaker: ERNESTO, kind: "finish_place" });
  });

  it("ambiente: solo tras un silencio largo y en las versiones de valoración", () => {
    const quiet = { lastMessageVersion: 60, lastSpokeAt: {} };
    expect(plan(routine, { version: 100, director: quiet }).utterances[0]?.trigger).toBe("ambient");
    expect(plan(routine, { version: 90, director: quiet }).utterances).toEqual([]); // solo 30 de silencio
    expect(plan(routine, { version: 101, director: { lastMessageVersion: 10 } }).utterances).toEqual([]); // no toca valorar
    const kinds = new Set(
      Array.from({ length: 200 }, (_, s) => plan(routine, { version: 100, director: quiet, random: createSeededRandom(s) }).utterances[0]?.kind),
    );
    expect([...kinds].filter(Boolean).every((k) => k === "ambient_ahead" || k === "ambient_behind")).toBe(true);
  });

  it("es reproducible con la misma semilla", () => {
    const run = (seed: number) =>
      Array.from({ length: 50 }, (_, i) => plan([capture(CHARACTER_IDS[i % 4], CHARACTER_IDS[(i + 1) % 4])], { random: createSeededRandom(seed + i) }).utterances);
    expect(run(5)).toEqual(run(5));
  });
});

describe("frecuencia, pausas y límites", () => {
  it("pausa de personaje: quien habló hace menos de 8 versiones no habla ni replica", () => {
    const director = { lastMessageVersion: 95, lastSpokeAt: { [BRAVA]: 95 } };
    for (let seed = 1; seed <= 100; seed++) {
      for (const u of plan([capture(BRAVA, ERNESTO)], { director, random: createSeededRandom(seed) }).utterances) {
        expect(u.speaker).not.toBe(BRAVA);
      }
    }
    // A las 8 versiones ya puede.
    expect(plan([capture(BRAVA, ERNESTO)], { version: 103, director }).utterances[0].speaker).toBe(BRAVA);
  });

  it("pausa global: menos de 3 versiones desde el último mensaje → silencio", () => {
    expect(plan([capture(BRAVA, ERNESTO)], { director: { lastMessageVersion: 99 } }).utterances).toEqual([]);
    expect(plan([capture(BRAVA, ERNESTO)], { director: { lastMessageVersion: 98 } }).utterances).not.toEqual([]);
  });

  it("máximo 60 por partida, con 2 reservados para la victoria", () => {
    const max = CHAT_LIMITS.maxMessagesPerGame;
    expect(plan([capture(BRAVA, ERNESTO)], { messageCount: max - 2 }).utterances).toEqual([]);
    expect(plan([capture(BRAVA, ERNESTO)], { messageCount: max - 3 }).utterances).toHaveLength(1); // sin sitio para réplica
    const victory: GameEvent[] = [{ type: "player_finished", playerId: BRAVA, place: 1 }];
    expect(plan(victory, { messageCount: max - 2 }).utterances).toHaveLength(2);
    expect(plan(victory, { messageCount: max - 1 }).utterances).toHaveLength(1);
    expect(plan(victory, { messageCount: max }).utterances).toEqual([]);
    // Tras la victoria ya no se reserva nada.
    expect(plan([capture(BRAVA, ERNESTO)], { messageCount: max - 2, state: game({ ranking: [PILAR] }) }).utterances).toHaveLength(2);
  });

  it("los personajes habladores intervienen más que los reservados", () => {
    const rate = (by: string, victim: string) => {
      let spoken = 0;
      for (let seed = 1; seed <= 1000; seed++) spoken += plan([capture(by, victim)], { random: createSeededRandom(seed) }).utterances.length;
      return spoken / 1000;
    };
    expect(rate(BRAVA, CHISPA)).toBeGreaterThan(rate(ERNESTO, PILAR) * 1.3);
  });

  it("recordPublished recuerda las frases usadas por cada personaje (sin duplicar, con límite)", () => {
    let director = recordPublished(initialDirectorState(), 5, [
      { speaker: BRAVA, text: "a", lineId: "goal:0" },
      { speaker: CHISPA, text: "b", lineId: "goal:0" },
    ]);
    director = recordPublished(director, 20, [{ speaker: BRAVA, text: "c", lineId: "goal:1" }]);
    director = recordPublished(director, 40, [{ speaker: BRAVA, text: "d", lineId: "goal:0" }]); // vuelve al final
    director = recordPublished(director, 60, [{ speaker: PILAR, text: "e" }]); // sin lineId (p. ej. un LLM)
    expect(director.usedLines).toEqual({ [BRAVA]: ["goal:1", "goal:0"], [CHISPA]: ["goal:0"] });
    for (let i = 0; i < CHAT_LIMITS.usedLinesPerCharacter + 5; i++) {
      director = recordPublished(director, 100 + i, [{ speaker: BRAVA, text: `t${i}`, lineId: `ambient_ahead:${i}` }]);
    }
    expect(director.usedLines[BRAVA]).toHaveLength(CHAT_LIMITS.usedLinesPerCharacter);
  });

  it("recordPublished actualiza tiempos y textos recientes (como mucho 12)", () => {
    let director = initialDirectorState();
    for (let v = 1; v <= 20; v++) director = recordPublished(director, v, [{ speaker: CHISPA, text: `texto ${v}` }]);
    expect(director.lastMessageVersion).toBe(20);
    expect(director.lastSpokeAt[CHISPA]).toBe(20);
    expect(director.recent).toHaveLength(CHAT_LIMITS.recentTexts);
    expect(recordPublished(director, 21, [])).toBe(director);
  });
});

describe("registro de coletillas por partida (usedCatchphrases)", () => {
  it("registra, por personaje, las coletillas de lo publicado (del LLM o local), sin duplicados", () => {
    let d = initialDirectorState();
    expect(d.usedCatchphrases).toEqual({});
    // Pilar (LLM, sin lineId) y Brava (local, con lineId) en la misma versión.
    d = recordPublished(d, 327, [
      { speaker: PILAR, text: "Despacito y buena letra, hijito, que la paciencia siempre gana la partida." },
      { speaker: BRAVA, text: "¡A casa, Chispa!", lineId: "capture_boast:0" },
    ]);
    expect(d.usedCatchphrases).toEqual({ [PILAR]: [0], [BRAVA]: [0] });
    // Cientos de versiones después, la misma coletilla no se duplica y se añade otra nueva.
    d = recordPublished(d, 671, [{ speaker: PILAR, text: "Ay, hijo, qué prisas. Despacito y buena letra." }]);
    expect(d.usedCatchphrases[PILAR]).toEqual([0, 1]);
    // Palabras comunes y coletillas de otros no se registran.
    d = recordPublished(d, 700, [{ speaker: CHISPA, text: "Vuelve a casa, Brava. Previsible." }]);
    expect(d.usedCatchphrases[CHISPA]).toBeUndefined();
  });

  it("cada partida tiene su propio registro (estado puro, sin estado global)", () => {
    const a = recordPublished(initialDirectorState(), 10, [{ speaker: ERNESTO, text: "Previsible, Chispa." }]);
    const b = initialDirectorState();
    expect(a.usedCatchphrases).toEqual({ [ERNESTO]: [0] });
    expect(b.usedCatchphrases).toEqual({});
    expect(recordPublished(b, 10, []).usedCatchphrases).toEqual({});
  });

  it("un estado guardado antes de existir el campo se lee con el registro vacío", () => {
    const old = { lastMessageVersion: 40, lastSpokeAt: { [BRAVA]: 40 }, captures: [], recent: [], usedLines: {} };
    expect(DirectorStateSchema.parse(old).usedCatchphrases).toEqual({});
    expect(DirectorStateSchema.safeParse({ ...old, usedCatchphrases: { [BRAVA]: [-1] } }).success).toBe(false);
  });
});

describe("ambiente: liderazgo y posiciones reales", () => {
  const talkOf = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.talkativeness;
  /** Partida con la ficha 0 de cada personaje en esos `steps` (los demás en casa). */
  function withSteps(steps: Partial<Record<string, number>>): GameState {
    const state = game();
    for (const p of state.players) {
      const st = steps[p.id];
      if (st !== undefined) p.pieces[0] = { ...p.pieces[0], steps: st, state: "track" };
    }
    return state;
  }
  const byPlayer = (state: GameState) => {
    const out: Record<string, string[]> = {};
    for (const c of ambientCandidates(state)) (out[c.speaker] ??= []).push(`${c.kind}:${c.rival ?? "-"}`);
    return out;
  };
  const weightsSumToTalkativeness = (state: GameState) => {
    for (const id of CHARACTER_IDS) {
      const total = ambientCandidates(state).filter((c) => c.speaker === id).reduce((n, c) => n + c.weight, 0);
      expect(total, id).toBeCloseTo(talkOf(id));
    }
  };

  it("primero en solitario: solo él lidera; segundo y tercero, neutral o «por detrás»; el último no nombra a un último", () => {
    const state = withSteps({ [PILAR]: 40, [BRAVA]: 30, [ERNESTO]: 20, [CHISPA]: 10 });
    expect(byPlayer(state)).toEqual({
      [PILAR]: [`ambient_lead:${CHISPA}`],
      [BRAVA]: [`ambient_ahead:${CHISPA}`, `ambient_behind:${PILAR}`],
      [ERNESTO]: [`ambient_ahead:${CHISPA}`, `ambient_behind:${PILAR}`],
      [CHISPA]: ["ambient_ahead:-", `ambient_behind:${PILAR}`],
    });
    weightsSumToTalkativeness(state);
  });

  it("empate en cabeza: nadie lidera, los empatados no dicen que van por detrás y no se nombra a un «primero»", () => {
    const state = withSteps({ [BRAVA]: 40, [CHISPA]: 40, [ERNESTO]: 20, [PILAR]: 10 });
    expect(byPlayer(state)).toEqual({
      [BRAVA]: [`ambient_ahead:${PILAR}`],
      [CHISPA]: [`ambient_ahead:${PILAR}`],
      [ERNESTO]: [`ambient_ahead:${PILAR}`, "ambient_behind:-"],
      [PILAR]: ["ambient_ahead:-", "ambient_behind:-"],
    });
    weightsSumToTalkativeness(state);
  });

  it("empate total (todos con el mismo progreso): solo frases neutrales, sin rival; la partida no se queda en silencio", () => {
    const state = game();
    const candidates = ambientCandidates(state);
    expect(candidates.map((c) => `${c.speaker}:${c.kind}:${c.rival ?? "-"}`)).toEqual(CHARACTER_IDS.map((id) => `${id}:ambient_ahead:-`));
    weightsSumToTalkativeness(state);
    const quiet = { lastMessageVersion: 10, lastSpokeAt: {} };
    const spoken = Array.from({ length: 50 }, (_, s) => plan(routine, { version: 100, state, director: quiet, random: createSeededRandom(s) }).utterances[0]);
    expect(spoken.some(Boolean)).toBe(true);
    expect(spoken.filter(Boolean).every((u) => u!.kind === "ambient_ahead" && u!.rival === null)).toBe(true);
  });

  it("empate en el último puesto: no se nombra a ningún «último»", () => {
    const state = withSteps({ [BRAVA]: 40, [ERNESTO]: 20, [PILAR]: 10, [CHISPA]: 10 });
    for (const c of ambientCandidates(state)) {
      if (c.kind !== "ambient_behind") expect(c.rival, `${c.speaker} ${c.kind}`).toBeNull();
    }
    expect(byPlayer(state)[BRAVA]).toEqual(["ambient_lead:-"]);
  });

  it("los empates no favorecen a Brava por el orden de los jugadores: Brava y Chispa reciben lo mismo", () => {
    const tied = withSteps({ [BRAVA]: 30, [CHISPA]: 30, [ERNESTO]: 10, [PILAR]: 10 });
    const options = byPlayer(tied);
    expect(options[BRAVA]).toEqual(options[CHISPA]);
    expect(options[BRAVA]).not.toContain(expect.stringMatching(/^ambient_lead/));
    // Igual al intercambiar sus progresos.
    const swapped = withSteps({ [BRAVA]: 10, [CHISPA]: 10, [ERNESTO]: 30, [PILAR]: 30 });
    expect(byPlayer(swapped)[ERNESTO]).toEqual(byPlayer(swapped)[PILAR]);
  });

  it("a través del director: con un líder en solitario, solo él usa `ambient_lead`", () => {
    const state = withSteps({ [PILAR]: 40, [BRAVA]: 30, [ERNESTO]: 20, [CHISPA]: 10 });
    const quiet = { lastMessageVersion: 10, lastSpokeAt: {} };
    const kinds = Array.from({ length: 200 }, (_, s) => plan(routine, { version: 100, state, director: quiet, random: createSeededRandom(s) }).utterances[0]).filter(Boolean);
    expect(kinds.some((u) => u!.kind === "ambient_lead")).toBe(true);
    for (const u of kinds) if (u!.kind === "ambient_lead") expect(u!.speaker).toBe(PILAR);
  });

  // ── Después de la primera victoria (alternativa A, partida 88d4e4f8…) ──
  const finished = (state: GameState, ranking: string[]): GameState => ({ ...state, ranking });
  /** Los activos conservan su `talkativeness` completo; quien ya terminó no tiene candidatos. */
  const activeWeights = (state: GameState) => {
    for (const id of CHARACTER_IDS) {
      const total = ambientCandidates(state).filter((c) => c.speaker === id).reduce((n, c) => n + c.weight, 0);
      expect(total, id).toBeCloseTo(state.ranking.includes(id) ? 0 : talkOf(id));
    }
  };

  it("sin nadie terminado, el primero en solitario sigue recibiendo `ambient_lead`", () => {
    const state = withSteps({ [ERNESTO]: 40, [BRAVA]: 30, [PILAR]: 20, [CHISPA]: 10 });
    expect(byPlayer(state)[ERNESTO]).toEqual([`ambient_lead:${CHISPA}`]);
  });

  it("con Chispa ya ganadora: Don Ernesto, primero entre los activos, no lidera y usa `ambient_ahead` (el resto, igual)", () => {
    const state = finished(withSteps({ [ERNESTO]: 40, [BRAVA]: 30, [PILAR]: 20, [CHISPA]: 75 }), [CHISPA]);
    expect(byPlayer(state)).toEqual({
      [ERNESTO]: [`ambient_ahead:${PILAR}`],
      [BRAVA]: [`ambient_ahead:${PILAR}`, `ambient_behind:${ERNESTO}`],
      [PILAR]: ["ambient_ahead:-", `ambient_behind:${ERNESTO}`],
    });
    activeWeights(state);
  });

  it("con un ganador, los empates entre los activos se comportan igual que antes", () => {
    // Empate en cabeza entre Brava y Pilar (Chispa ya ganó): nadie es primero ni último en solitario... salvo Ernesto, último.
    const tieTop = finished(withSteps({ [BRAVA]: 40, [PILAR]: 40, [ERNESTO]: 10 }), [CHISPA]);
    expect(byPlayer(tieTop)).toEqual({
      [BRAVA]: [`ambient_ahead:${ERNESTO}`],
      [PILAR]: [`ambient_ahead:${ERNESTO}`],
      [ERNESTO]: ["ambient_ahead:-", "ambient_behind:-"],
    });
    activeWeights(tieTop);
    // Empate total entre los activos: solo frases neutrales, sin rival.
    const allTied = finished(game(), [CHISPA]);
    expect(ambientCandidates(allTied).every((c) => c.kind === "ambient_ahead" && c.rival === null)).toBe(true);
    activeWeights(allTied);
  });

  it("tras cualquier victoria, nadie recibe `ambient_lead` (gane quien gane, y también con varios terminados)", () => {
    for (const winner of CHARACTER_IDS) {
      const others = CHARACTER_IDS.filter((id) => id !== winner);
      const steps = { [others[0]]: 40, [others[1]]: 20, [others[2]]: 10 };
      const state = finished(withSteps(steps), [winner]);
      expect(ambientCandidates(state).some((c) => c.kind === "ambient_lead"), winner).toBe(false);
      expect(byPlayer(state)[others[0]], winner).toEqual([`ambient_ahead:${others[2]}`]);
      activeWeights(state);
      // Con dos terminados, tampoco.
      const two = finished(withSteps(steps), [winner, others[2]]);
      expect(ambientCandidates(two).some((c) => c.kind === "ambient_lead"), `${winner} y otro`).toBe(false);
      activeWeights(two);
    }
  });

  it("a través del director: con un ganador, ningún comentario de ambiente es de liderazgo", () => {
    const state = finished(withSteps({ [ERNESTO]: 40, [BRAVA]: 30, [PILAR]: 20 }), [CHISPA]);
    const quiet = { lastMessageVersion: 10, lastSpokeAt: {} };
    const spoken = Array.from({ length: 200 }, (_, s) => plan(routine, { version: 100, state, director: quiet, random: createSeededRandom(s) }).utterances[0]).filter(Boolean);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.some((u) => u!.kind === "ambient_lead")).toBe(false);
    expect(spoken.some((u) => u!.speaker === ERNESTO && u!.kind === "ambient_ahead")).toBe(true);
  });
});
