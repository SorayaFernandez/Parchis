import { describe, expect, it } from "vitest";
import { createSeededRandom } from "@/lib/game/ai";
import { CHARACTERS, CHARACTER_NAMES, CHAT_LINE_KINDS, LINE_KINDS_WITH_RIVAL, LINE_KINDS_WITH_STREAK } from "@/lib/game/characters";
import { CHAT_LIMITS } from "../config";
import type { Utterance } from "../director";
import { detectCatchphrases } from "../catchphrases";
import { checkQuality } from "../llm/quality";
import { countWord, createLocalWriter, isRepeated, renderLine, similarity, validateChatText, type RecentText } from "../writer";

const [BRAVA, ERNESTO, PILAR, CHISPA] = CHARACTERS;
const longestName = Object.values(CHARACTER_NAMES).sort((a, b) => b.length - a.length)[0];
const allLines = (c: (typeof CHARACTERS)[number]) => CHAT_LINE_KINDS.flatMap((k) => c.chat.lines[k]);

const utterance = (speaker: string, kind: Utterance["kind"], rival: string | null = null, streak?: Utterance["streak"]): Utterance => ({
  speaker,
  kind,
  rival,
  trigger: "capture",
  replyTo: null,
  important: true,
  ...(streak ? { streak } : {}),
});
/** Frase rellenada con el nombre más largo y la racha más larga razonable (para medir y validar). */
const fill = (line: string) =>
  line.replaceAll("{rival}", longestName).replaceAll("{Count}", "Cuatro").replaceAll("{count}", "cuatro").replaceAll("{ritmo}", "en poco tiempo");

describe("personalidades y frases locales", () => {
  it("cada personaje tiene registro, frecuencia y al menos 4 frases de cada tipo (5 en capturas y victorias)", () => {
    for (const c of CHARACTERS) {
      expect(c.chat.register.length).toBeGreaterThan(20);
      expect(c.chat.talkativeness).toBeGreaterThan(0);
      for (const kind of CHAT_LINE_KINDS) expect(c.chat.lines[kind].length, `${c.id} ${kind}`).toBeGreaterThanOrEqual(4);
      expect(c.chat.lines.capture_boast.length).toBeGreaterThanOrEqual(5);
      expect(c.chat.lines.victory_win.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("las frases están bien formadas: solo los marcadores de su tipo, y caben con cualquier nombre y racha", () => {
    for (const c of CHARACTERS) {
      for (const kind of CHAT_LINE_KINDS) {
        for (const line of c.chat.lines[kind]) {
          expect(line.replace(/\{(rival|count|Count|ritmo)\}/g, ""), line).not.toMatch(/[{}<>]/);
          if (!LINE_KINDS_WITH_RIVAL.has(kind)) expect(line, `${c.id} ${kind}`).not.toContain("{rival}");
          if (!LINE_KINDS_WITH_STREAK.has(kind)) expect(line, `${c.id} ${kind}`).not.toMatch(/\{(count|Count|ritmo)\}/);
          const rendered = fill(line);
          expect(rendered.length, line).toBeLessThanOrEqual(CHAT_LIMITS.maxTextLength);
          expect(validateChatText(rendered, [])).toBe(rendered);
        }
      }
    }
  });

  it("no hay frases repetidas ni casi iguales, ni dentro de un personaje ni entre personajes", () => {
    const lines = CHARACTERS.flatMap((c) => allLines(c).map((line) => ({ id: c.id, line: fill(line) })));
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        expect(similarity(lines[i].line, lines[j].line), `${lines[i].line} ~ ${lines[j].line}`).toBeLessThan(CHAT_LIMITS.maxSimilarity);
      }
    }
  });

  it("cada uno suena distinto", () => {
    const exclaim = (c: (typeof CHARACTERS)[number]) => allLines(c).filter((l) => l.includes("¡")).length / allLines(c).length;
    // Brava y Chispa exclaman mucho; Don Ernesto nunca (formal) y trata de usted.
    expect(exclaim(BRAVA)).toBeGreaterThan(0.3);
    expect(exclaim(CHISPA)).toBeGreaterThan(0.3);
    expect(exclaim(ERNESTO)).toBe(0);
    expect(allLines(ERNESTO).some((l) => /\b(usted|le recomiendo|revise|debería)\b/i.test(l))).toBe(true);
    // Pilar: cariño, diminutivos y refranes.
    expect(allLines(PILAR).filter((l) => /cariño|hij[oa]s?|cielo|-?it[ao]\b|casita|fichita|poquito/i.test(l)).length).toBeGreaterThan(8);
    // Brava: frases cortas.
    const avg = (c: (typeof CHARACTERS)[number]) => allLines(c).reduce((s, l) => s + l.length, 0) / allLines(c).length;
    expect(avg(BRAVA)).toBeLessThan(avg(ERNESTO));
  });
});

describe("concordancia de la frase de ambiente de Chispa (C)", () => {
  it("«{rival} va a toda máquina» funciona con los cuatro nombres y ya no hay «va lanzado»", () => {
    const chispa = CHARACTERS.find((c) => c.id === "ai-blue")!;
    const template = "{rival} va a toda máquina. Pero esto no ha acabado.";
    expect(chispa.chat.lines.ambient_behind).toContain(template);
    expect(CHARACTERS.flatMap((c) => Object.values(c.chat.lines).flat()).some((l) => /lanzad[oa]/.test(l))).toBe(false);
    for (const rival of CHARACTERS) {
      const u = { speaker: "ai-blue", kind: "ambient_behind", rival: rival.id, trigger: "ambient", replyTo: null, important: false } as Utterance;
      expect(renderLine(template, u)).toBe(`${CHARACTER_NAMES[rival.id]} va a toda máquina. Pero esto no ha acabado.`);
    }
  });
});

describe("escritor local y antirrepetición", () => {
  it("renderLine sustituye {rival} y descarta la frase si falta el rival", () => {
    expect(renderLine("¡A casa, {rival}!", { rival: "ai-blue" })).toBe("¡A casa, Chispa!");
    expect(renderLine("¡A casa, {rival}!", { rival: null })).toBeNull();
    expect(renderLine("Sin rival.", { rival: null })).toBe("Sin rival.");
  });

  it("renderLine usa el número real de la racha y solo dice 'seguidas' si lo fueron", () => {
    const line = "¡{Count} capturas {ritmo}! Y van {count}.";
    expect(renderLine(line, { rival: null, streak: { count: 2, consecutive: true } })).toBe("¡Dos capturas seguidas! Y van dos.");
    expect(renderLine(line, { rival: null, streak: { count: 3, consecutive: false } })).toBe("¡Tres capturas en poco tiempo! Y van tres.");
    expect(renderLine(line, { rival: null })).toBeNull(); // sin datos de racha no se inventa el número
    expect(countWord(12)).toBe("12");
  });

  it("escribe una frase del personaje y del tipo pedidos, con el nombre del rival", async () => {
    const writer = createLocalWriter(createSeededRandom(1));
    const result = await writer.write({ utterance: utterance(BRAVA.id, "capture_boast", PILAR.id), recent: [], replyToText: null });
    expect(result?.source).toBe("local");
    expect(BRAVA.chat.lines.capture_boast.map((l) => l.replaceAll("{rival}", "Abuela Pilar"))).toContain(result!.text);
  });

  it("no repite textos recientes: agota las opciones y luego calla", async () => {
    const writer = createLocalWriter(createSeededRandom(3));
    const recent: RecentText[] = [];
    const total = PILAR.chat.lines.goal.length;
    for (let i = 0; i < total; i++) {
      const result = await writer.write({ utterance: utterance(PILAR.id, "goal"), recent, replyToText: null });
      expect(result).not.toBeNull();
      expect(isRepeated(result!.text, recent)).toBe(false);
      recent.push({ speaker: PILAR.id, text: result!.text });
    }
    expect(await writer.write({ utterance: utterance(PILAR.id, "goal"), recent, replyToText: null })).toBeNull();
  });

  it("validateChatText: limpia espacios y rechaza vacíos, largos, plantillas y textos casi iguales", () => {
    expect(validateChatText("  Hola   a todos  ", [])).toBe("Hola a todos");
    expect(validateChatText("   ", [])).toBeNull();
    expect(validateChatText("x".repeat(CHAT_LIMITS.maxTextLength + 1), [])).toBeNull();
    expect(validateChatText("Hola {rival}", [])).toBeNull();
    const recent = [{ speaker: "ai-pink", text: "¡A casa, Chispa!" }];
    expect(validateChatText("¡A casa, Chispa!!", recent)).toBeNull();
    expect(validateChatText("a casa chispa", recent)).toBeNull();
    expect(validateChatText("Una frase completamente distinta.", recent)).not.toBeNull();
  });

  it("similarity: 1 para textos iguales (sin tildes ni signos) y baja para distintos", () => {
    expect(similarity("¡Qué alegría!", "que alegria")).toBe(1);
    expect(similarity("Despacito y buena letra", "Captura ejecutada")).toBeLessThan(0.2);
  });
});

describe("antirrepetición con distintos rivales", () => {
  it("la misma frase dirigida a otro personaje cuenta como repetida", () => {
    expect(similarity("Vale, Brava. Pido el VAR.", "Vale, Abuela Pilar. Pido el VAR.")).toBe(1);
    expect(isRepeated("¡A casa, Don Ernesto!", [{ speaker: "ai-pink", text: "¡A casa, Chispa!" }])).toBe(true);
  });
});

describe("antirrepetición por personaje (M2)", () => {
  it("agota todas las frases de un tipo antes de repetir ninguna, y después repite la más antigua", async () => {
    const writer = createLocalWriter(createSeededRandom(5));
    const used: string[] = [];
    const total = BRAVA.chat.lines.capture_boast.length;
    for (let i = 0; i < total; i++) {
      const r = await writer.write({ utterance: utterance(BRAVA.id, "capture_boast", PILAR.id), recent: [], replyToText: null, usedLines: used });
      expect(used).not.toContain(r!.lineId);
      used.push(r!.lineId!);
    }
    expect(new Set(used).size).toBe(total);
    const next = await writer.write({ utterance: utterance(BRAVA.id, "capture_boast", PILAR.id), recent: [], replyToText: null, usedLines: used });
    expect(next!.lineId).toBe(used[0]);
  });

  it("la memoria es por personaje: lo que usa uno no limita a otro", async () => {
    const writer = createLocalWriter(createSeededRandom(6));
    const usedByBrava = BRAVA.chat.lines.goal.map((_, i) => `goal:${i}`);
    const r = await writer.write({ utterance: utterance(CHISPA.id, "goal"), recent: [], replyToText: null, usedLines: [] });
    expect(r).not.toBeNull();
    expect(usedByBrava).toContain(r!.lineId); // mismo id posible, pero son frases de Chispa
  });
});

describe("coherencia de las frases con lo que pasa (B3 y M1)", () => {
  const linesOf = (kinds: readonly (typeof CHAT_LINE_KINDS)[number][]) =>
    CHARACTERS.flatMap((c) => kinds.flatMap((k) => c.chat.lines[k].map((line) => ({ who: c.id, kind: k, line }))));

  it("tres seises: nunca dicen que una ficha vuelve a casa (a veces no hay ficha que devolver)", () => {
    for (const { line } of linesOf(["third_six_self", "third_six_tease"])) expect(line).not.toMatch(/casa|empezar otra vez|vuelta a empezar/i);
  });

  it("meta, puesto final y victoria no confunden la meta con la casa", () => {
    for (const { line } of linesOf(["goal", "finish_place", "victory_win", "victory_reply"])) expect(line).not.toMatch(/\bcasa|casita/i);
  });

  it("victoria y puesto final no se despiden ni dan la partida por acabada (los demás siguen jugando)", () => {
    for (const { line } of linesOf(["victory_win", "victory_reply", "finish_place"])) {
      expect(line).not.toMatch(/gracias por participar|qué final|partida memorable|fin de la partida|os dejo jugando|retransmisi|el resto ya lo narro|comentarista a tiempo completo|desde el sofá/i);
    }
  });

  it("rachas: el número y la consecutividad salen siempre de los datos, nunca escritos a mano", () => {
    for (const { line } of linesOf(["streak_boast", "streak_lament"])) {
      expect(line).not.toMatch(/\b(dos|tres|cuatro|doblete|seguidas|seguidos)\b|de dos|otra vez tú|tomada conmigo|a la tercera/i);
    }
  });
});

describe("escritor local y coletillas ya publicadas", () => {
  const brava = (extra: Partial<Utterance> = {}): Utterance =>
    ({ speaker: "ai-pink", kind: "capture_boast", rival: "ai-blue", trigger: "capture", replyTo: null, important: true, ...extra }) as Utterance;

  it("prefiere frases sin las coletillas que el personaje ya ha publicado en la partida", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const written = await createLocalWriter(createSeededRandom(seed)).write({ utterance: brava(), recent: [], replyToText: null, usedCatchphrases: [0, 1] });
      expect(written).not.toBeNull();
      expect(detectCatchphrases("ai-pink", written!.text), written!.text).toEqual([]);
    }
  });

  it("si todas las frases válidas tienen una coletilla ya usada, responde igualmente (nunca se queda sin frase)", async () => {
    // Las frases sin coletilla «se parecen» a textos recientes y quedan descartadas por la antirrepetición.
    const lines = CHARACTERS.find((c) => c.id === "ai-pink")!.chat.lines.capture_boast.map((l) => renderLine(l, brava())!);
    const recent = lines.filter((t) => detectCatchphrases("ai-pink", t).length === 0).map((text) => ({ speaker: "ai-blue", text }));
    const written = await createLocalWriter(createSeededRandom(1)).write({ utterance: brava(), recent, replyToText: null, usedCatchphrases: [0, 1] });
    expect(written).not.toBeNull();
    expect(detectCatchphrases("ai-pink", written!.text).length).toBeGreaterThan(0);
  });
});

describe("frases de ambiente: ninguna afirma una posición que no le corresponde", () => {
  // Afirmaciones de liderazgo propio (no las que hablan de la ventaja del rival, como «no confunda ventaja con victoria»).
  const LEADERSHIP = /voy ganando|^ganando|en cabeza|mantengo la ventaja|encabezo|la primera|primero en|delante de todos|aquí arriba|control del tablero|voy primer/iu;
  const SELF_BEHIND = /voy perdiendo|voy por detrás|voy atrás|voy el último|voy la última/i;
  const ambient = (kind: "ambient_lead" | "ambient_ahead" | "ambient_behind") => CHARACTERS.map((c) => ({ name: c.name, lines: c.chat.lines[kind] }));

  it("solo `ambient_lead` (primero en solitario) afirma ir ganando o en cabeza", () => {
    for (const { name, lines } of ambient("ambient_lead")) expect(lines.some((l) => LEADERSHIP.test(l)), name).toBe(true);
    for (const kind of ["ambient_ahead", "ambient_behind"] as const) {
      for (const { name, lines } of ambient(kind)) for (const l of lines) expect(LEADERSHIP.test(l), `${name}/${kind}: ${l}`).toBe(false);
    }
  });

  it("las frases neutrales (`ambient_ahead`) no dicen que el personaje va por detrás, y las de liderazgo tampoco", () => {
    for (const kind of ["ambient_lead", "ambient_ahead"] as const) {
      for (const { name, lines } of ambient(kind)) for (const l of lines) expect(SELF_BEHIND.test(l), `${name}/${kind}: ${l}`).toBe(false);
    }
  });

  it("cada tipo de ambiente tiene frases sin rival (para empates); las neutrales, al menos tres", () => {
    for (const kind of ["ambient_lead", "ambient_ahead", "ambient_behind"] as const) {
      for (const { name, lines } of ambient(kind)) {
        const withoutRival = lines.filter((l) => !l.includes("{rival}")).length;
        expect(withoutRival, `${name}/${kind}`).toBeGreaterThanOrEqual(kind === "ambient_ahead" ? 3 : 1);
        expect(lines.length, `${name}/${kind}`).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

describe("frases neutrales y «por detrás»: ninguna afirma una buena posición propia", () => {
  /**
   * Afirmaciones de posición favorable del propio personaje (liderazgo, ventaja o buena posición). Solo
   * caben en `ambient_lead`. No incluye la ventaja de un rival («no confunda ventaja con victoria»).
   */
  const GOOD_POSITION =
    /posici[oó]n es s[oó]lida|buena posici[oó]n|voy bien|voy delante|voy por delante|llevo (la )?ventaja|mantengo la ventaja|tengo ventaja|estoy liderando|lidero|encabezo|voy ganando|^ganando|en cabeza|voy primer[oa]|la primera|primero en|delante de todos|aquí arriba|control del tablero/iu;

  it("el patrón detecta afirmaciones de posición, también las que hoy no existen en el catálogo", () => {
    for (const text of [
      "La posición es sólida. Sigamos así.",
      "Voy bien, ¿eh? Sin correr, pero sin parar.",
      "Voy delante, cariño.",
      "Llevo ventaja y lo sabéis.",
      "Estoy liderando, señores.",
      "Encabezo la partida, tal como había calculado.",
      "Voy ganando. ¡Que se note!",
      "Mantengo la ventaja. Paciencia y método.",
    ]) {
      expect(GOOD_POSITION.test(text), text).toBe(true);
    }
  });

  it("y deja pasar frases neutrales legítimas y la ventaja de un rival", () => {
    for (const text of [
      "Analizo cada tirada. El plan sigue en marcha.",
      "Sin correr, pero sin parar, cariño.",
      "Sigo en la pelea. ¡Que tiemble el tablero!",
      "Poquito a poco voy llegando.",
      "El dado me guiña un ojo. Buena señal.",
      "{rival}, no confunda ventaja con victoria.",
      "Una desventaja temporal. Nada que un buen plan no corrija.",
    ]) {
      expect(GOOD_POSITION.test(text), text).toBe(false);
    }
  });

  it("ninguna frase de `ambient_ahead` ni de `ambient_behind` de los cuatro personajes la contiene", () => {
    for (const c of CHARACTERS) {
      for (const kind of ["ambient_ahead", "ambient_behind"] as const) {
        for (const line of c.chat.lines[kind]) expect(GOOD_POSITION.test(line), `${c.name}/${kind}: ${line}`).toBe(false);
      }
    }
  });

  it("las de liderazgo siguen disponibles para el primero en solitario, con el último en solitario o sin rival", async () => {
    for (const c of CHARACTERS) {
      expect(c.chat.lines.ambient_lead.some((l) => GOOD_POSITION.test(l)), c.name).toBe(true);
      const last = CHARACTERS.find((o) => o.id !== c.id)!.id;
      for (const rival of [last, null]) {
        const u = { speaker: c.id, kind: "ambient_lead", rival, trigger: "ambient", replyTo: null, important: false } as Utterance;
        const written = await createLocalWriter(createSeededRandom(1)).write({ utterance: u, recent: [], replyToText: null });
        expect(written, `${c.name} con rival ${rival}`).not.toBeNull();
        expect(c.chat.lines.ambient_lead.map((l) => renderLine(l, u))).toContain(written!.text);
      }
    }
  });
});

describe("frases locales: comentarios de cuatro personas en la mesa, sin jerga ni elementos ajenos (P3)", () => {
  const JARGON =
    /señores|en directo|a cámara|cámara lenta|narrador|abracadabra|autógrafo|gato negro|guion|\bvar\b|go+l\b|golazo|escuadra|público|prensa|récord|podio|ovación|confeti|palomitas|aperturas|\bfase\b|retaguardia|retrovisor|caldito|repetición|sentencia|momento histórico|astros/iu;

  it("ninguna frase local usa jerga de televisión, deportes o elementos ajenos al parchís", () => {
    for (const c of CHARACTERS) {
      for (const [kind, lines] of Object.entries(c.chat.lines)) {
        for (const line of lines) expect(JARGON.test(line), `${c.name}/${kind}: ${line}`).toBe(false);
      }
    }
  });

  it("Chispa sigue siendo espontáneo y supersticioso con el dado (no un comentarista)", () => {
    const chispa = CHARACTERS.find((c) => c.id === "ai-blue")!;
    const all = Object.values(chispa.chat.lines).flat();
    expect(all.filter((l) => /dado|suerte|amuleto|mal de ojo|gafe|madera|horóscopo|calcetines/i.test(l)).length).toBeGreaterThanOrEqual(8);
    expect(`${chispa.personality} ${chispa.chat.register} ${chispa.chat.voice}`).not.toMatch(/comentarista|racha|teatral/i);
  });
});

describe("P4: historial incompleto (sin `streak` ni hechos fiables) con las frases locales", () => {
  it("cada personaje tiene frases sin datos en cada tipo de captura y racha, y ninguna afirma cifras ni rachas", async () => {
    const kinds = ["capture_boast", "capture_lament", "streak_boast", "streak_lament"] as const;
    for (const c of CHARACTERS) {
      const rival = CHARACTERS.find((x) => x.id !== c.id)!.id;
      for (const kind of kinds) {
        const selfRole = kind.endsWith("boast") ? "by" : "victim";
        const trigger = kind === "streak_boast" ? "capture_streak" : kind === "streak_lament" ? "bad_streak" : "capture";
        const u: Utterance = { speaker: c.id, kind, trigger, rival, replyTo: null, important: true, captures: { history: "incomplete", selfRole } };
        const usable = c.chat.lines[kind].map((line) => renderLine(line, u)).filter((t): t is string => t !== null);
        expect(usable.length, `${c.name} ${kind}`).toBeGreaterThan(0);
        for (const text of usable) expect(checkQuality(text, { utterance: u, recent: [], replyToText: null }), `${c.name} ${kind}: ${text}`).toBeNull();
        // El escritor local responde con una de ellas (nunca con una que necesite `{count}` o `{ritmo}`).
        const written = await createLocalWriter(createSeededRandom(7)).write({ utterance: u, recent: [], replyToText: null });
        expect(usable).toContain(written?.text);
      }
    }
  });
});
