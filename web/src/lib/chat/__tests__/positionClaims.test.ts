import { describe, expect, it } from "vitest";
import { createGame, type GameState, type PlayerId } from "@/lib/engine";
import { createSeededRandom } from "@/lib/game/ai";
import { CHARACTERS, CHARACTER_IDS } from "@/lib/game/characters";
import { getPlayerSummaries } from "@/lib/hud/summary";
import { ambientCandidates, gameLast, gameLeader, type Utterance } from "../director";
import { positionClaims, unbackedPositionClaim, unbackedWinClaim } from "../positionClaims";
import { createLocalWriter, renderLine } from "../writer";

const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"] as const;

/** Partida en juego con el progreso que se pide: cada jugador, una ficha en el recorrido con esos `steps`. */
function standing(steps: Partial<Record<PlayerId, number>>, options: { finished?: PlayerId[]; status?: GameState["status"] } = {}): GameState {
  const state = createGame([...CHARACTER_IDS]);
  for (const player of state.players) {
    if (options.finished?.includes(player.id)) {
      for (const piece of player.pieces) Object.assign(piece, { state: "finished", steps: 75 });
    } else if (steps[player.id] !== undefined) {
      Object.assign(player.pieces[0], { state: "track", steps: steps[player.id] });
    }
  }
  state.ranking = [...(options.finished ?? [])];
  if (options.status) state.status = options.status;
  return state;
}
const progressOf = (state: GameState) => Object.fromEntries(getPlayerSummaries(state).map((p) => [p.id, p.progress]));

const say = (speaker: string, rival: string | null, standingData: { leader?: PlayerId | null; last?: PlayerId | null }, kind = "capture_boast") => ({
  utterance: { speaker, kind, rival, trigger: "capture", replyTo: null, important: true } as Utterance,
  ...standingData,
});

describe("clasificación real: gameLeader y gameLast (progreso de getPlayerSummaries)", () => {
  it("líder y último en solitario, con posiciones intermedias", () => {
    const state = standing({ [BRAVA]: 40, [ERNESTO]: 20, [PILAR]: 10, [CHISPA]: 5 });
    expect(progressOf(state)[BRAVA]).toBeGreaterThan(progressOf(state)[ERNESTO]);
    expect(gameLeader(state)).toBe(BRAVA);
    expect(gameLast(state)).toBe(CHISPA);
  });

  it("empates: en cabeza no hay líder, en el último puesto no hay último, todos empatados ninguno", () => {
    expect(gameLeader(standing({ [BRAVA]: 40, [ERNESTO]: 40, [PILAR]: 10, [CHISPA]: 5 }))).toBeNull();
    expect(gameLast(standing({ [BRAVA]: 40, [ERNESTO]: 40, [PILAR]: 10, [CHISPA]: 5 }))).toBe(CHISPA);
    expect(gameLast(standing({ [BRAVA]: 40, [ERNESTO]: 20, [PILAR]: 5, [CHISPA]: 5 }))).toBeNull();
    expect(gameLeader(standing({ [BRAVA]: 40, [ERNESTO]: 20, [PILAR]: 5, [CHISPA]: 5 }))).toBe(BRAVA);
    const tied = standing({});
    expect(gameLeader(tied)).toBeNull();
    expect(gameLast(tied)).toBeNull();
  });

  it("tras la primera victoria ya nadie «va ganando», pero el último entre los que siguen sí va perdiendo", () => {
    const state = standing({ [ERNESTO]: 30, [PILAR]: 20, [CHISPA]: 5 }, { finished: [BRAVA] });
    expect(gameLeader(state)).toBeNull();
    expect(gameLast(state)).toBe(CHISPA);
    // Con un solo jugador sin terminar, o con la partida terminada, no se puede saber.
    expect(gameLast(standing({ [CHISPA]: 5 }, { finished: [BRAVA, ERNESTO, PILAR] }))).toBeNull();
    expect(gameLast(standing({ [BRAVA]: 40, [CHISPA]: 5 }, { status: "finished" }))).toBeNull();
    expect(gameLeader(standing({ [BRAVA]: 40, [CHISPA]: 5 }, { status: "finished" }))).toBeNull();
  });

  it("es el mismo criterio que el ambiente: `ambient_lead` solo al líder y su rival es el último", () => {
    const state = standing({ [BRAVA]: 40, [ERNESTO]: 20, [PILAR]: 10, [CHISPA]: 5 });
    const lead = ambientCandidates(state).filter((c) => c.kind === "ambient_lead");
    expect(lead.map((c) => [c.speaker, c.rival])).toEqual([[gameLeader(state), gameLast(state)]]);
  });
});

describe("afirmaciones de posición: se reconocen con su sujeto", () => {
  it("variantes de ganar y perder, de quien habla, del rival, en plural y en negativo", () => {
    const kinds = (text: string, speaker: string = BRAVA) => positionClaims(text, speaker).map((c) => `${c.kind}:${c.subject}${c.negated ? ":no" : ""}`);
    expect(kinds("Voy ganando.")).toEqual(["lead:self"]);
    expect(kinds("Estoy ganando, Chispa.")).toEqual(["lead:self"]);
    expect(kinds("Sigo ganando.")).toEqual(["lead:self"]);
    expect(kinds("Encabezo la partida.")).toEqual(["lead:self"]);
    expect(kinds("Estoy liderando.")).toEqual(["lead:self"]);
    expect(kinds("Voy perdiendo.")).toEqual(["last:self"]);
    expect(kinds("Voy por detrás, pero la partida es larga.")).toEqual(["last:self"]);
    expect(kinds("Me he quedado atrás.")).toEqual(["last:self"]);
    expect(kinds("Vas ganando, Chispa.")).toEqual(["lead:rival"]);
    expect(kinds("Chispa va perdiendo.")).toEqual(["last:rival"]);
    expect(kinds("Chispa, ánimo, que vas muy atrás.")).toEqual(["last:rival"]);
    expect(kinds("Te has quedado muy atrás.")).toEqual(["last:rival"]);
    expect(kinds("Te estás quedando atrás.")).toEqual(["last:rival"]);
    expect(kinds("Vamos ganando.")).toEqual(["lead:group"]);
    expect(kinds("No voy ganando.")).toEqual(["lead:self:no"]);
    expect(kinds("Todavía no vas perdiendo.")).toEqual(["last:rival:no"]);
    // «La abuela va ganando» dicho por Pilar habla de ella misma; dicho por otro, del rival.
    expect(kinds("La abuela va ganando.", PILAR)).toEqual(["lead:self"]);
    expect(kinds("La abuela va ganando.", CHISPA)).toEqual(["lead:rival"]);
  });

  it("no son afirmaciones de posición: otros sentidos, exhortaciones y frases relativas", () => {
    for (const text of [
      "Estoy perdiendo la paciencia.", "Voy ganando tiempo.", "No te quedes atrás.", "¡Una dentro! Las demás van detrás.", "Brava va muy rápido.",
      "Ya te alcanzo.", "Voy a por ti.", "Esta partida me está gustando.", "He perdido una ficha.", "Voy por detrás de ti.",
    ]) expect(positionClaims(text, BRAVA), text).toEqual([]);
  });
});

describe("afirmaciones de posición: solo con la clasificación real", () => {
  it("líder: «Voy ganando» solo si quien habla va primero en solitario", () => {
    expect(unbackedPositionClaim("Voy ganando.", say(BRAVA, CHISPA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Encabezo la partida.", say(BRAVA, CHISPA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Voy ganando.", say(BRAVA, CHISPA, { leader: ERNESTO, last: CHISPA }))).toBe("voy ganando");
  });

  it("último: «Voy perdiendo» solo si quien habla va último en solitario; en posiciones intermedias, no", () => {
    expect(unbackedPositionClaim("Voy perdiendo.", say(CHISPA, BRAVA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Me he quedado atrás.", say(CHISPA, BRAVA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    // Pilar va tercera (ni primera ni última): no puede decir ninguna de las dos cosas.
    for (const text of ["Voy perdiendo.", "Voy ganando.", "Voy por detrás.", "Sigo perdiendo."]) {
      expect(unbackedPositionClaim(text, say(PILAR, BRAVA, { leader: BRAVA, last: CHISPA })), text).not.toBeNull();
    }
  });

  it("del rival: se comprueba la posición real del rival", () => {
    expect(unbackedPositionClaim("Vas ganando, Brava.", say(CHISPA, BRAVA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Vas ganando, Pilar.", say(CHISPA, PILAR, { leader: BRAVA, last: CHISPA }))).toBe("vas ganando");
    expect(unbackedPositionClaim("Chispa va perdiendo.", say(BRAVA, CHISPA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Chispa va perdiendo.", say(BRAVA, CHISPA, { leader: BRAVA, last: PILAR }))).toBe("va perdiendo");
    expect(unbackedPositionClaim("Te has quedado muy atrás.", say(BRAVA, CHISPA, { leader: BRAVA, last: CHISPA }))).toBeNull();
    expect(unbackedPositionClaim("Te has quedado muy atrás.", say(BRAVA, ERNESTO, { leader: BRAVA, last: CHISPA }))).toBe("te has quedado muy atras");
    // Sin rival en la intervención (victoria propia), una afirmación sobre «el rival» no tiene a quién referirse.
    expect(unbackedPositionClaim("Vas perdiendo.", say(BRAVA, null, { leader: null, last: CHISPA }))).toBe("vas perdiendo");
  });

  it("empate: si no hay un líder o un último únicos, nadie puede afirmarlo", () => {
    expect(unbackedPositionClaim("Voy ganando.", say(BRAVA, CHISPA, { leader: null, last: CHISPA }))).toBe("voy ganando");
    expect(unbackedPositionClaim("Voy perdiendo.", say(CHISPA, BRAVA, { leader: BRAVA, last: null }))).toBe("voy perdiendo");
  });

  it("estado insuficiente: sin clasificación (estado no válido) no se afirma nada", () => {
    for (const text of ["Voy ganando.", "Voy perdiendo.", "Vas ganando, Chispa.", "Chispa va perdiendo."]) {
      expect(unbackedPositionClaim(text, say(BRAVA, CHISPA, {})), text).not.toBeNull();
    }
  });

  it("en plural o en negativo no se puede comprobar: se rechaza", () => {
    expect(unbackedPositionClaim("Vamos ganando.", say(BRAVA, CHISPA, { leader: BRAVA, last: CHISPA }))).toBe("vamos ganando");
    expect(unbackedPositionClaim("No voy ganando.", say(PILAR, CHISPA, { leader: BRAVA, last: CHISPA }))).toBe("voy ganando");
  });

  it("sin afirmaciones de posición, nada que comprobar", () => {
    expect(unbackedPositionClaim("Te comí, Chispa.", say(BRAVA, CHISPA, {}))).toBeNull();
  });
});

describe("catálogo local y escritor local: nunca afirman una posición falsa", () => {
  const lines = (id: string, kind: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines[kind as "ambient_behind"];

  it("«Voy perdiendo» (ambient_behind) solo sale si quien habla va último; si no, otra frase suya", async () => {
    for (const speaker of [BRAVA, PILAR, CHISPA]) {
      const claims = lines(speaker, "ambient_behind").filter((l) => positionClaims(l, speaker).length > 0);
      expect(claims.length, speaker).toBeGreaterThan(0);
      const others = CHARACTER_IDS.filter((id) => id !== speaker);
      const u = { speaker, kind: "ambient_behind", rival: others[0], trigger: "ambient", replyTo: null, important: false } as Utterance;
      const texts = new Set<string>();
      for (let seed = 1; seed <= 40; seed++) {
        // Va segundo o tercero: alguien por delante (el rival, primero) y otro por detrás (el último).
        const written = await createLocalWriter(createSeededRandom(seed)).write({ utterance: u, recent: [], replyToText: null, leader: others[0], last: others[1] });
        if (written) texts.add(written.text);
      }
      for (const text of texts) expect(positionClaims(text, speaker), `${speaker}: ${text}`).toEqual([]);
      // Si va último, sí puede decirlo.
      const asLast = new Set<string>();
      for (let seed = 1; seed <= 40; seed++) {
        const written = await createLocalWriter(createSeededRandom(seed)).write({ utterance: u, recent: [], replyToText: null, leader: others[0], last: speaker });
        if (written) asLast.add(written.text);
      }
      expect([...asLast].some((text) => positionClaims(text, speaker).length > 0), speaker).toBe(true);
    }
  });

  it("sin clasificación, el escritor local no elige frases que afirmen una posición (calla si no le queda otra)", async () => {
    for (const c of CHARACTERS) {
      for (const kind of ["ambient_lead", "ambient_ahead", "ambient_behind"] as const) {
        const rival = CHARACTER_IDS.find((id) => id !== c.id)!;
        const u = { speaker: c.id, kind, rival, trigger: "ambient", replyTo: null, important: false } as Utterance;
        const written = await createLocalWriter(createSeededRandom(1)).write({ utterance: u, recent: [], replyToText: null });
        if (written) expect(unbackedPositionClaim(written.text, { utterance: u }), `${c.name}/${kind}: ${written.text}`).toBeNull();
      }
    }
  });

  it("cada frase de ambiente del catálogo es cierta en la situación en la que el director la ofrece", () => {
    for (const c of CHARACTERS) {
      const rival = CHARACTER_IDS.find((id) => id !== c.id)!;
      const situations = {
        // ambient_lead: quien habla, primero; su rival, último.
        ambient_lead: { leader: c.id, last: rival, rival },
        // ambient_ahead: no lidera; su rival, si lo nombra, es el último.
        ambient_ahead: { leader: null, last: rival, rival },
        // ambient_behind: su rival, si lo nombra, es el primero; quien habla va último (único caso en el que puede decir «voy perdiendo»).
        ambient_behind: { leader: rival, last: c.id, rival },
      } as const;
      for (const [kind, s] of Object.entries(situations)) {
        const u = { speaker: c.id, kind, rival: s.rival, trigger: "ambient", replyTo: null, important: false } as Utterance;
        for (const line of c.chat.lines[kind as keyof typeof situations]) {
          const text = renderLine(line, u);
          if (text) expect(unbackedPositionClaim(text, { utterance: u, leader: s.leader, last: s.last }), `${c.name}/${kind}: ${text}`).toBeNull();
        }
      }
    }
  });

  it("ninguna frase fuera del ambiente afirma ir ganando o perdiendo", () => {
    for (const c of CHARACTERS) {
      for (const [kind, kindLines] of Object.entries(c.chat.lines)) {
        if (kind.startsWith("ambient_")) continue;
        for (const line of kindLines) expect(positionClaims(line, c.id), `${c.name}/${kind}: ${line}`).toEqual([]);
      }
    }
  });
});

describe("demostración", () => {
  it("ningún mensaje afirma una posición falsa: se comprueba con la clasificación real de su versión", async () => {
    const { createDemoMatch, newDemoMatch, nextDemoAction, seededDemoRandom, stepDemo, DEMO_SEED, DEMO_START_ACTIONS } = await import("@/lib/board/demo");
    const final = await createDemoMatch();
    const byVersion = new Map(final.messages.map((m) => [`${m.version}:${m.seq}`, m]));
    const random = seededDemoRandom(DEMO_SEED);
    let match = newDemoMatch();
    for (let i = 0; i < DEMO_START_ACTIONS && match.state.status === "playing"; i++) {
      const next = await stepDemo(match, nextDemoAction(match.state, random), random);
      if (!next) throw new Error("acción ilegal en la demostración");
      match = next;
      for (const seq of [0, 1]) {
        const m = byVersion.get(`${match.version}:${seq}`);
        if (!m) continue;
        const claims = positionClaims(m.text, m.characterId);
        if (claims.length === 0) continue;
        // Las afirmaciones de la demostración son sobre quien habla (las del rival se comprueban igual en las pruebas unitarias).
        const u = { speaker: m.characterId, kind: "ambient_lead", rival: null, trigger: m.trigger, replyTo: null, important: false } as Utterance;
        expect(unbackedPositionClaim(m.text, { utterance: u, leader: gameLeader(match.state), last: gameLast(match.state) }), `v${m.version}: ${m.text}`).toBeNull();
      }
    }
    expect(match.version).toBe(final.version);
    // (Antes la v110 decía «Voy perdiendo, sí. Por ahora.» con Brava tercera; la partida de la demostración ha
    // cambiado con el reparto de la palabra, y la comprobación de arriba cubre cualquier versión.)
  });
});

describe("afirmar que un rival gana: solo si ya ha ganado de verdad", () => {
  const u = (speaker: string, rival: string | null, kind = "capture_lament", trigger = "capture") => ({ speaker, kind, rival, trigger, replyTo: null, important: true }) as Utterance;
  it("sin ganador, con otro ganador, con el rival como ganador y en la réplica a su victoria", () => {
    expect(unbackedWinClaim("No me extraña que Brava gane.", { utterance: u(PILAR, BRAVA), winner: null })).toBe("extraña que brava gane");
    expect(unbackedWinClaim("No me extraña que Brava gane.", { utterance: u(PILAR, BRAVA) })).toBe("extraña que brava gane");
    expect(unbackedWinClaim("No me extraña que Brava gane.", { utterance: u(PILAR, BRAVA), winner: CHISPA })).toBe("extraña que brava gane");
    expect(unbackedWinClaim("No me extraña que Brava gane.", { utterance: u(PILAR, BRAVA), winner: BRAVA })).toBeNull();
    expect(unbackedWinClaim("No me extraña que ganes.", { utterance: u(PILAR, BRAVA, "victory_reply", "victory") })).toBeNull();
    expect(unbackedWinClaim("Abuela, vas a ganar.", { utterance: u(CHISPA, PILAR), winner: null })).toBe("vas a ganar");
    expect(unbackedWinClaim("La abuela va a ganar.", { utterance: u(CHISPA, PILAR), winner: null })).toBe("la abuela va a ganar");
  });
  it("el escritor local nunca lo dice sin respaldo: ninguna frase del catálogo lo afirma fuera de la réplica a una victoria", () => {
    for (const c of CHARACTERS) {
      for (const [kind, kindLines] of Object.entries(c.chat.lines)) {
        if (kind === "victory_reply") continue;
        for (const rival of CHARACTER_IDS.filter((id) => id !== c.id)) {
          const utterance = u(c.id, rival, kind);
          for (const line of kindLines) {
            const text = renderLine(line, utterance);
            if (text) expect(unbackedWinClaim(text, { utterance, winner: null }), `${c.name}/${kind}: ${text}`).toBeNull();
          }
        }
      }
    }
  });
});

describe("«la partida» no excluye la afirmación (M-a de la auditoría final)", () => {
  const STANDING = { leader: BRAVA, last: CHISPA } as const;

  it("se reconocen con y sin «la partida», en primera persona y del rival, ganando y perdiendo", () => {
    const kinds = (text: string, speaker: string = BRAVA) => positionClaims(text, speaker).map((c) => `${c.kind}:${c.subject}`);
    for (const [text, expected] of [
      ["Voy ganando.", "lead:self"], ["Voy ganando la partida.", "lead:self"], ["Estoy ganando la partida, Chispa.", "lead:self"],
      ["Voy perdiendo.", "last:self"], ["Voy perdiendo la partida.", "last:self"], ["Sigo perdiendo la partida.", "last:self"],
      ["Vas ganando, Chispa.", "lead:rival"], ["Vas ganando la partida, Chispa.", "lead:rival"],
      ["Vas perdiendo la partida, Chispa.", "last:rival"], ["Chispa va perdiendo la partida.", "last:rival"],
    ] as const) expect(kinds(text), text).toEqual([expected]);
  });

  it("líder y último: solo con la clasificación real que los respalda", () => {
    expect(unbackedPositionClaim("Voy ganando la partida.", say(BRAVA, CHISPA, STANDING))).toBeNull();
    expect(unbackedPositionClaim("Voy ganando la partida.", say(ERNESTO, CHISPA, STANDING))).toBe("voy ganando");
    expect(unbackedPositionClaim("Voy perdiendo la partida.", say(CHISPA, BRAVA, STANDING))).toBeNull();
    expect(unbackedPositionClaim("Voy perdiendo la partida.", say(PILAR, BRAVA, STANDING))).toBe("voy perdiendo");
    expect(unbackedPositionClaim("Vas ganando la partida, Brava.", say(CHISPA, BRAVA, STANDING))).toBeNull();
    expect(unbackedPositionClaim("Vas ganando la partida, Pilar.", say(CHISPA, PILAR, STANDING))).toBe("vas ganando");
    expect(unbackedPositionClaim("Vas perdiendo la partida, Chispa.", say(BRAVA, CHISPA, STANDING))).toBeNull();
    expect(unbackedPositionClaim("Vas perdiendo la partida, Pilar.", say(BRAVA, PILAR, STANDING))).toBe("vas perdiendo");
  });

  it("empate y clasificación no disponible: no se puede afirmar, con o sin «la partida»", () => {
    for (const text of ["Voy ganando.", "Voy ganando la partida."]) {
      expect(unbackedPositionClaim(text, say(BRAVA, CHISPA, { leader: null, last: CHISPA })), text).toBe("voy ganando");
      expect(unbackedPositionClaim(text, say(BRAVA, CHISPA, {})), text).toBe("voy ganando");
    }
    for (const text of ["Voy perdiendo.", "Voy perdiendo la partida."]) {
      expect(unbackedPositionClaim(text, say(CHISPA, BRAVA, { leader: BRAVA, last: null })), text).toBe("voy perdiendo");
      expect(unbackedPositionClaim(text, say(CHISPA, BRAVA, {})), text).toBe("voy perdiendo");
    }
  });

  it("siguen sin ser afirmaciones de posición los otros sentidos, también con «la»", () => {
    for (const text of [
      "Estoy perdiendo la paciencia.", "Voy perdiendo la cuenta.", "Voy ganando la confianza.", "Estoy ganando tiempo.", "Voy perdiendo fichas.",
      "Estoy perdiendo la paciencia con esta partida.", "Voy ganando terreno.", "No te quedes atrás.",
    ]) expect(positionClaims(text, BRAVA), text).toEqual([]);
  });

  it("por el flujo completo del validador: rechazado sin respaldo, aceptado con él", async () => {
    const { checkQuality } = await import("../llm/quality");
    const request = (speaker: string, rival: string, standing: { leader?: string | null; last?: string | null }) =>
      ({ utterance: { speaker, kind: "ambient_ahead", rival, trigger: "ambient", replyTo: null, important: false }, recent: [], replyToText: null, ...standing }) as Parameters<typeof checkQuality>[1];
    expect(checkQuality("Voy ganando la partida.", request(ERNESTO, CHISPA, STANDING))).toEqual({ reason: "afirmación no respaldada", term: "voy ganando" });
    expect(checkQuality("Voy ganando la partida.", request(BRAVA, CHISPA, STANDING))).toBeNull();
    expect(checkQuality("Voy perdiendo la partida.", request(PILAR, BRAVA, STANDING))).toEqual({ reason: "afirmación no respaldada", term: "voy perdiendo" });
    expect(checkQuality("Estoy perdiendo la paciencia.", request(PILAR, BRAVA, STANDING))).toBeNull();
  });
});
