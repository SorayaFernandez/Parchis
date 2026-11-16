// Reparto de la palabra, réplicas que contestan, frases sustituidas y quejas de barrera (2026-11-16).
import { describe, expect, it, vi } from "vitest";
import { createGame, getRealBoardPosition, type Color, type GameEvent, type GameState, type PlayerId } from "@/lib/engine";
import { createSeededRandom } from "@/lib/game/ai";
import { CHARACTERS, CHARACTER_IDS, REPLY_LINE_KINDS, getCharacter } from "@/lib/game/characters";
import { balanceFactor, blockedByRivalBarrier, captureFacts, initialDirectorState, planChat, type Utterance } from "../director";
import { createLocalWriter, renderLine, type ChatWriteRequest } from "../writer";

vi.mock("server-only", () => ({}));

const { checkQuality, hasDiscardedExpression } = await import("../llm/quality");
const { cleanLlmText, ChatLlmError } = await import("../llm/gatewayWriter");
const { buildChatPrompt } = await import("../llm/prompt");

const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"] as const;
const PLAYERS: PlayerId[] = [...CHARACTER_IDS];
const name = (id: string) => getCharacter(id)!.name;

describe("reparto de la palabra: cuotas orientativas, no rígidas", () => {
  it("las cuotas son las pedidas y suman 1", () => {
    expect(CHARACTERS.map((c) => [c.id, c.chat.share])).toEqual([[BRAVA, 0.27], [ERNESTO, 0.27], [PILAR, 0.19], [CHISPA, 0.27]]);
  });

  it("balanceFactor: neutro al empezar y con el reparto justo; sube a quien ha hablado poco y baja a quien ha hablado mucho, con límites", () => {
    const at = (spoken: Record<string, number>, id: string, lastSpokeAt: Record<string, number> = { [BRAVA]: 90, [ERNESTO]: 90, [PILAR]: 90, [CHISPA]: 90 }) =>
      balanceFactor({ ...initialDirectorState(), spoken, lastSpokeAt }, PLAYERS, id, 100);
    expect(at({}, BRAVA)).toBeCloseTo(1, 5);
    expect(at({ [BRAVA]: 27, [ERNESTO]: 27, [PILAR]: 19, [CHISPA]: 27 }, PILAR)).toBeCloseTo(1, 5);
    // Brava ha monopolizado la palabra: baja; Don Ernesto apenas ha hablado: sube.
    const monopoly = { [BRAVA]: 20, [ERNESTO]: 1, [PILAR]: 2, [CHISPA]: 3 };
    expect(at(monopoly, BRAVA)).toBeLessThan(0.6);
    expect(at(monopoly, ERNESTO)).toBeGreaterThan(2);
    // Acotado: nunca anula ni dispara a nadie.
    const extreme = { [BRAVA]: 500, [ERNESTO]: 0, [PILAR]: 0, [CHISPA]: 0 };
    expect(at(extreme, BRAVA)).toBeGreaterThanOrEqual(0.4);
    expect(at(extreme, ERNESTO)).toBeLessThanOrEqual(2.5);
    // Con pocas intervenciones corrige con moderación (suavizado): no deja callado a nadie.
    expect(at({ [BRAVA]: 2 }, BRAVA)).toBeGreaterThan(0.45);
    // Mucho tiempo sin hablar: un empujón.
    expect(balanceFactor({ ...initialDirectorState(), lastSpokeAt: { [PILAR]: 10 } }, PLAYERS, PILAR, 400)).toBeCloseTo(1.5, 5);
  });

  it("en una captura, quien ha hablado mucho cede la palabra; la probabilidad de que alguien hable no cambia", () => {
    const event: GameEvent = { type: "piece_captured", playerId: BRAVA, victimId: ERNESTO, victimPieceIndex: 0, cell: 30 };
    const sample = (spoken: Record<string, number>) => {
      const random = createSeededRandom(5);
      let talked = 0;
      let brava = 0;
      for (let i = 0; i < 4000; i++) {
        const director = { ...initialDirectorState(), spoken, lastSpokeAt: { [BRAVA]: 450, [ERNESTO]: 450, [PILAR]: 450, [CHISPA]: 450 } };
        const { utterances } = planChat({ version: 500, events: [event], state: createGame([...CHARACTER_IDS]), messageCount: 0, director }, random);
        if (utterances.length === 0) continue;
        talked++;
        if (utterances[0].speaker === BRAVA) brava++;
      }
      return { rate: talked / 4000, brava: brava / talked };
    };
    const fair = sample({});
    const bravaTalkedTooMuch = sample({ [BRAVA]: 20, [ERNESTO]: 2, [PILAR]: 4, [CHISPA]: 6 });
    expect(bravaTalkedTooMuch.brava).toBeLessThan(fair.brava - 0.15);
    expect(Math.abs(bravaTalkedTooMuch.rate - fair.rate)).toBeLessThan(0.03);
  });

  it("las réplicas no pasan por el reparto: quien recibe el mensaje responde igual, haya hablado mucho o poco", () => {
    const event: GameEvent = { type: "piece_captured", playerId: BRAVA, victimId: ERNESTO, victimPieceIndex: 0, cell: 30 };
    const replyRate = (spoken: Record<string, number>) => {
      const random = createSeededRandom(9);
      let mainsByBrava = 0;
      let replies = 0;
      for (let i = 0; i < 6000; i++) {
        const director = { ...initialDirectorState(), spoken, lastSpokeAt: { [BRAVA]: 450, [ERNESTO]: 450 } };
        const { utterances } = planChat({ version: 500, events: [event], state: createGame([...CHARACTER_IDS]), messageCount: 0, director }, random);
        if (utterances[0]?.speaker !== BRAVA) continue;
        mainsByBrava++;
        if (utterances[1]?.speaker === ERNESTO) replies++;
      }
      return replies / mainsByBrava;
    };
    // Don Ernesto ha hablado muchísimo o nada: su probabilidad de contestar a Brava es la misma.
    expect(Math.abs(replyRate({ [ERNESTO]: 40, [BRAVA]: 1 }) - replyRate({ [ERNESTO]: 0, [BRAVA]: 1 }))).toBeLessThan(0.04);
  });

  it(
    "en partidas completas (motor, IA y chat local reales) el reparto se acerca al pedido y nadie monopoliza",
    async () => {
      const { newDemoMatch, nextDemoAction, seededDemoRandom, stepDemo } = await import("@/lib/board/demo");
      const total: Record<string, number> = {};
      for (let g = 0; g < 16; g++) {
        const random = seededDemoRandom(1000 + g * 997);
        let match = newDemoMatch();
        while (match.state.status === "playing" && match.version < 3000) {
          const next = await stepDemo(match, nextDemoAction(match.state, random), random);
          if (!next) throw new Error("acción ilegal");
          match = next;
        }
        const game: Record<string, number> = {};
        for (const m of match.messages) if (m.seq === 0 && m.trigger !== "victory") game[m.characterId] = (game[m.characterId] ?? 0) + 1;
        const n = Object.values(game).reduce((a, b) => a + b, 0);
        for (const [id, count] of Object.entries(game)) {
          expect(count / n, `partida ${g}: ${id}`).toBeLessThan(0.45);
          total[id] = (total[id] ?? 0) + count;
        }
      }
      const n = Object.values(total).reduce((a, b) => a + b, 0);
      const share = (id: string) => (total[id] ?? 0) / n;
      // Orientativo, no exacto: ±4 puntos sobre 27 / 27 / 27 / 19 %.
      for (const id of [BRAVA, ERNESTO, CHISPA]) expect(Math.abs(share(id) - 0.27), id).toBeLessThan(0.04);
      expect(Math.abs(share(PILAR) - 0.19)).toBeLessThan(0.04);
      expect(share(PILAR)).toBeLessThan(Math.min(share(BRAVA), share(ERNESTO), share(CHISPA)));
    },
    120_000,
  );
});

describe("réplicas que contestan, no que repiten", () => {
  const capturer = (speaker: string, victim: string, replyToText: string | null = null) =>
    ({
      utterance: { speaker, kind: "capture_boast", rival: victim, trigger: "capture", replyTo: replyToText ? 0 : null, important: true, captures: captureFacts([{ v: 10, by: speaker, victim }], 10, speaker, victim, speaker) },
      recent: [],
      replyToText,
    }) as ChatWriteRequest;
  const victimOf = (speaker: string, by: string, replyToText: string | null = null) =>
    ({
      utterance: { speaker, kind: "capture_lament", rival: by, trigger: "capture", replyTo: replyToText ? 0 : null, important: true, captures: captureFacts([{ v: 10, by, victim: speaker }], 10, by, victim(speaker), speaker) },
      recent: [],
      replyToText,
    }) as ChatWriteRequest;
  function victim(id: string) {
    return id;
  }
  const reject = (text: string, request: ChatWriteRequest) => {
    try {
      cleanLlmText(text, request);
      return null;
    } catch (error) {
      return error instanceof ChatLlmError ? error.message : String(error);
    }
  };

  it("el ejemplo pedido: a «¡Vaya, me has comido una ficha!», «Te comí la ficha» repite y «Sí, te comí la ficha» contesta", () => {
    const pilar = "¡Vaya, me has comido una ficha!";
    expect(reject("Te comí la ficha.", capturer(CHISPA, PILAR, pilar))).toBe("repite el mensaje anterior");
    expect(reject("Sí, te comí la ficha.", capturer(CHISPA, PILAR, pilar))).toBeNull();
    expect(reject("Te comí la ficha, jeje.", capturer(CHISPA, PILAR, pilar))).toBeNull();
    // Desde el otro lado, igual: repetir «me has comido una ficha» a quien acaba de presumir no contesta.
    expect(reject("Me has comido una ficha, Chispa.", victimOf(PILAR, CHISPA, "¡Te comí, Abuela Pilar!"))).toBe("repite el mensaje anterior");
    expect(reject("¡Esto no se queda así!", victimOf(BRAVA, CHISPA, "¡Te comí, Brava!"))).toBeNull();
    // Fuera de una réplica, la misma frase es un mensaje normal.
    expect(reject("Te comí la ficha.", capturer(CHISPA, PILAR))).toBeNull();
  });

  it("cada personaje tiene réplicas propias para las capturas, variadas (no todas empiezan igual ni por «Sí») y válidas con cualquier rival", () => {
    for (const c of CHARACTERS) {
      for (const kind of REPLY_LINE_KINDS) {
        const replies = c.chat.replies[kind] ?? [];
        expect(replies.length, `${c.name}/${kind}`).toBeGreaterThanOrEqual(4);
        expect(replies.filter((l) => /^[¡¿]?s[ií]\b/iu.test(l)).length, `${c.name}/${kind}`).toBeLessThanOrEqual(1);
        expect(new Set(replies.map((l) => l.split(/\s+/)[0])).size, `${c.name}/${kind}`).toBeGreaterThanOrEqual(3);
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const previous = kind === "capture_boast" ? `Me has comido, ${c.name}.` : `¡Te comí, ${rival.name}!`;
          const request = kind === "capture_boast" ? capturer(c.id, rival.id, previous) : victimOf(c.id, rival.id, previous);
          for (const line of replies) {
            const text = renderLine(line, request.utterance)!;
            expect(checkQuality(text, request), `${c.name} → ${rival.name}: ${text}`).toBeNull();
            expect(hasDiscardedExpression(text), text).toBe(false);
          }
        }
      }
    }
  });

  it("el escritor local usa las réplicas al contestar y las frases normales en el mensaje principal", async () => {
    for (const c of CHARACTERS) {
      const rival = CHARACTERS.find((r) => r.id !== c.id)!;
      const asReply = await createLocalWriter(createSeededRandom(3)).write(capturer(c.id, rival.id, "Me has comido."));
      const asMain = await createLocalWriter(createSeededRandom(3)).write(capturer(c.id, rival.id));
      const rendered = (lines: readonly string[]) => lines.map((l) => renderLine(l, { rival: rival.id } as Utterance));
      expect(rendered(c.chat.replies.capture_boast ?? []), c.name).toContain(asReply!.text);
      expect(asReply!.lineId, c.name).toMatch(/^reply:capture_boast:\d+$/);
      expect(rendered(c.chat.lines.capture_boast), c.name).toContain(asMain!.text);
    }
  });

  it("el prompt de una réplica pide contestar sin repetir la frase del otro", () => {
    const [, user] = buildChatPrompt(capturer(CHISPA, PILAR, "¡Vaya, me has comido una ficha!"));
    expect(user.content).toContain("Contesta a Abuela Pilar sin repetir su frase: «¡Vaya, me has comido una ficha!»");
  });
});

describe("frases sustituidas y retiradas", () => {
  const lines = (id: string) => getCharacter(id)!.chat.lines;

  it("las sustituciones están en su sitio y las frases antiguas ya no se generan", () => {
    expect(lines(PILAR).ambient_ahead).toContain("Poquito a poco voy avanzando.");
    expect(lines(PILAR).capture_lament).toContain("Me has comido, {rival}... pero qué le vamos a hacer.");
    expect(lines(BRAVA).streak_boast).toContain("¡Ya me he comido {count} fichas!");
    expect(lines(ERNESTO).capture_boast).toContain("Le he comido su ficha, {rival}.");
    expect(getCharacter(CHISPA)!.chat.replies.capture_boast).toContain("Te comí la ficha, jeje.");
    const all = CHARACTERS.flatMap((c) => [...Object.values(c.chat.lines).flat(), ...Object.values(c.chat.replies).flat()]);
    for (const old of ["Poquito a poco voy llegando.", "Me has comido, {rival}. Qué le vamos a hacer.", "¡Ya van {count} {ritmo}!"]) expect(all).not.toContain(old);
    expect(all.some((l) => /gustazo|la ficha a \{rival\}/iu.test(l))).toBe(false);
  });

  it("«¡Ya me he comido tres fichas!» solo con una racha real de tres capturas", () => {
    const facts = (n: number) => captureFacts(Array.from({ length: n }, (_, i) => ({ v: 10 + i, by: BRAVA, victim: CHISPA })), 10 + n - 1, BRAVA, CHISPA, BRAVA);
    const request = (n: number) =>
      ({ utterance: { speaker: BRAVA, kind: "streak_boast", rival: CHISPA, trigger: "capture_streak", replyTo: null, important: true, streak: { count: n, consecutive: true }, captures: facts(n) }, recent: [], replyToText: null }) as ChatWriteRequest;
    const text = renderLine("¡Ya me he comido {count} fichas!", request(3).utterance);
    expect(text).toBe("¡Ya me he comido tres fichas!");
    expect(checkQuality(text!, request(3))).toBeNull();
    // Con dos capturas reales, «tres fichas» sería falso.
    expect(checkQuality("¡Ya me he comido tres fichas!", request(2))?.reason).toBe("afirmación no respaldada");
  });

  it("«Le he comido la ficha a Brava» (dicho a Brava) y «el gustazo» se rechazan; «Le he comido su ficha, Brava», no", () => {
    const ernesto = { utterance: { speaker: ERNESTO, kind: "capture_boast", rival: BRAVA, trigger: "capture", replyTo: null, important: true }, recent: [], replyToText: null } as ChatWriteRequest;
    expect(checkQuality("Le he comido la ficha a Brava.", ernesto)).toEqual({ reason: "expresión poco natural", term: "ficha a + nombre" });
    expect(checkQuality("Le he comido su ficha, Brava.", ernesto)).toBeNull();
    const brava = { ...ernesto, utterance: { ...ernesto.utterance, speaker: BRAVA, rival: CHISPA } } as ChatWriteRequest;
    for (const text of ["¡Me he dado el gustazo de comerte la ficha!", "¡Qué gustazo, Chispa!", "Me di el gusto de comerte."]) {
      expect(checkQuality(text, brava), text).toEqual({ reason: "expresión poco natural", term: "gustazo" });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });
});

describe("«¡Abre la barrera!»: solo con un bloqueo real", () => {
  /** Coloca la ficha `index` de `color` en la casilla global `cell` (en el recorrido común). */
  const place = (state: GameState, color: Color, index: number, cell: number) => {
    const player = state.players.find((p) => p.color === color)!;
    const steps = Array.from({ length: 64 }, (_, s) => s).find((s) => getRealBoardPosition(color, s) === cell)!;
    Object.assign(player.pieces[index], { state: "track", steps });
  };
  /** Chispa (azul) en turno con un 4, su ficha en `from` y, si se pide, dos fichas de `barrierColor` en `barrierCell`. */
  const scene = (opts: { barrierCell?: number; barrierColor?: Color; mixed?: boolean; dice?: number | null }) => {
    const state = createGame([...CHARACTER_IDS]);
    state.turn = CHISPA;
    state.dice = opts.dice === undefined ? 4 : opts.dice;
    const from = getRealBoardPosition("blue", 10);
    place(state, "blue", 0, from);
    if (opts.barrierCell !== undefined) {
      place(state, opts.barrierColor ?? "pink", 0, opts.barrierCell);
      place(state, opts.mixed ? "green" : (opts.barrierColor ?? "pink"), opts.mixed ? 0 : 1, opts.barrierCell);
    }
    return state;
  };
  const ahead = (n: number) => getRealBoardPosition("blue", 10 + n);

  it("barrera de un rival en el camino de la tirada: sí, y se queja de su dueño", () => {
    expect(blockedByRivalBarrier(scene({ barrierCell: ahead(2) }))).toEqual({ speaker: CHISPA, owner: BRAVA });
    expect(blockedByRivalBarrier(scene({ barrierCell: ahead(4) }))).toEqual({ speaker: CHISPA, owner: BRAVA });
  });

  it("no basta con dos fichas juntas: sin bloqueo real, nada", () => {
    expect(blockedByRivalBarrier(scene({}))).toBeNull(); // ninguna barrera
    expect(blockedByRivalBarrier(scene({ barrierCell: ahead(6) }))).toBeNull(); // más allá de la tirada
    expect(blockedByRivalBarrier(scene({ barrierCell: getRealBoardPosition("blue", 5) }))).toBeNull(); // detrás
    expect(blockedByRivalBarrier(scene({ barrierCell: ahead(2), barrierColor: "blue" }))).toBeNull(); // propia
    expect(blockedByRivalBarrier(scene({ barrierCell: ahead(2), dice: null }))).toBeNull(); // sin dado
    // Dos fichas de colores distintos en una casilla normal no son barrera (y en un seguro no tienen un dueño).
    const mixed = scene({ barrierCell: ahead(2), mixed: true });
    expect(blockedByRivalBarrier(mixed)).toBeNull();
  });

  it("el director solo ofrece la queja con el bloqueo real, a quien está bloqueado y nombrando al dueño", () => {
    const planFor = (state: GameState) =>
      planChat({ version: 501, events: [{ type: "dice_rolled", playerId: CHISPA, value: 4 } as unknown as GameEvent], state, messageCount: 0, director: initialDirectorState() }, () => 0);
    expect(planFor(scene({ barrierCell: ahead(2) })).utterances).toEqual([
      { speaker: CHISPA, kind: "blockade_complaint", trigger: "ambient", rival: BRAVA, replyTo: null, important: false },
    ]);
    expect(planFor(scene({ barrierCell: ahead(6) })).utterances.some((u) => u.kind === "blockade_complaint")).toBe(false);
    expect(planFor(scene({ barrierCell: ahead(2), mixed: true })).utterances.some((u) => u.kind === "blockade_complaint")).toBe(false);
  });

  it("el validador solo admite pedir que abran la barrera en esa intervención", () => {
    const req = (kind: string) => ({ utterance: { speaker: CHISPA, kind, rival: BRAVA, trigger: kind === "blockade_complaint" ? "ambient" : "capture", replyTo: null, important: false }, recent: [], replyToText: null }) as ChatWriteRequest;
    for (const text of ["¡Abre la barrera, Brava!", "Brava, quita esa barrera.", "Esa barrera no me deja pasar, Brava."]) {
      expect(checkQuality(text, req("blockade_complaint")), text).toBeNull();
      expect(checkQuality(text, req("capture_lament")), text).toEqual({ reason: "afirmación no respaldada", term: "barrera sin bloqueo" });
    }
  });

  it("cada personaje tiene cuatro quejas de barrera, con su estilo y válidas con cualquier rival", () => {
    for (const c of CHARACTERS) {
      expect(c.chat.lines.blockade_complaint.length, c.name).toBeGreaterThanOrEqual(4);
      for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
        const utterance = { speaker: c.id, kind: "blockade_complaint", rival: rival.id, trigger: "ambient", replyTo: null, important: false } as Utterance;
        for (const line of c.chat.lines.blockade_complaint) {
          const text = renderLine(line, utterance)!;
          expect(checkQuality(text, { utterance, recent: [], replyToText: null }), `${c.name}: ${text}`).toBeNull();
        }
      }
    }
  });

  it("en la demostración, cada queja de barrera corresponde a un bloqueo real de su versión", async () => {
    const { createDemoMatch, newDemoMatch, nextDemoAction, seededDemoRandom, stepDemo, DEMO_SEED, DEMO_START_ACTIONS } = await import("@/lib/board/demo");
    const final = await createDemoMatch();
    const complaints = final.messages.filter((m) => m.trigger === "ambient" && getCharacter(m.characterId)!.chat.lines.blockade_complaint.some((l) => {
      const re = new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{rival\\\}/g, ".+")}$`, "u");
      return re.test(m.text);
    }));
    expect(complaints.length).toBeGreaterThan(0);
    const random = seededDemoRandom(DEMO_SEED);
    let match = newDemoMatch();
    for (let i = 0; i < DEMO_START_ACTIONS && match.state.status === "playing"; i++) {
      match = (await stepDemo(match, nextDemoAction(match.state, random), random))!;
      for (const m of complaints.filter((x) => x.version === match.version)) {
        const blocked = blockedByRivalBarrier(match.state);
        expect(blocked?.speaker, m.text).toBe(m.characterId);
        expect(m.text, m.text).toContain(name(blocked!.owner));
      }
    }
  });
});
