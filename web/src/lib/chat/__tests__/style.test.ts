// Estilo de las frases locales y del prompt: español de España natural y sencillo, relacionado con la
// partida, con la personalidad de cada personaje y sin debilitar la veracidad (las frases que puede
// escribir el LLM pasan el mismo validador con los hechos reales que calcula el director).
import { describe, expect, it } from "vitest";
import { CHARACTERS, CHAT_LINE_KINDS, type ChatLineKind } from "@/lib/game/characters";
import { captureFacts, type Utterance } from "../director";
import { detectCatchphrases } from "../catchphrases";
import { ChatLlmError, cleanLlmText } from "../llm/gatewayWriter";
import { buildChatPrompt } from "../llm/prompt";
import { checkQuality } from "../llm/quality";
import { renderLine } from "../writer";

type Character = (typeof CHARACTERS)[number];
const [BRAVA, ERNESTO, PILAR, CHISPA] = CHARACTERS;
const allLines = (c: Character) => CHAT_LINE_KINDS.flatMap((k) => c.chat.lines[k]);
const everyLine = () => CHARACTERS.flatMap((c) => CHAT_LINE_KINDS.flatMap((kind) => c.chat.lines[kind].map((line) => ({ c, kind, line }))));

describe("frases locales: español de España, natural y sencillo", () => {
  /** Expresiones artificiales, técnicas o grandilocuentes que se han sustituido (no deben volver). */
  const ARTIFICIAL =
    /ejecutad|táctic|cobertura|óptim|eficacia|eficiencia|teoría|recalcul|actuación|análisis|reglamento|implacable|conspiraci|intereses|sin querer… queriendo|mapa|que tiemble|guiña|entusiasta|combinación|patrón|notablemente|resultado aceptable|metódic|se impone al azar/iu;
  /** Rasgos de otras variedades del español o calcos del inglés. */
  const NOT_SPAIN = /\b(ahorita|platicar|chévere|órale|padrísimo|celular|computadora|chamba|carro|argh|wow|oops|yeah|okay|ok)\b/iu;
  /** Televisión, deportes y espectáculos: ningún personaje (tampoco Chispa) los usa. */
  const SHOW =
    /partido|remontada|experto|narra|comentar|retransm|marcador|\bgol|equipo|árbitro|tarjeta|pitido|afición|espectáculo|\bshow\b|televisi|\btele\b|cámara|micr[oó]fono|señores|en directo/iu;

  it("ninguna frase usa expresiones artificiales, de otras variedades del español ni de televisión o deportes", () => {
    for (const { c, kind, line } of everyLine()) {
      expect(ARTIFICIAL.test(line), `${c.name}/${kind}: ${line}`).toBe(false);
      expect(NOT_SPAIN.test(line), `${c.name}/${kind}: ${line}`).toBe(false);
      expect(SHOW.test(line), `${c.name}/${kind}: ${line}`).toBe(false);
    }
  });

  it("el plural de confianza es «vosotros» (no «ustedes»), salvo Don Ernesto, que trata de usted", () => {
    // Formas reales de vosotros, con límites de palabra Unicode (`\b` no reconoce «ñ» ni las tildes):
    // pronombres, presente y futuro en -áis/-éis (sin los numerales «dieciséis», «veintiséis»), «sois»,
    // «vais», pretérito en -steis e imperativos de una lista cerrada (nunca cualquier palabra en «-ad»).
    const IMPERATIVES = "temblad|tomad|mirad|esperad|apuntad|callad|venid|sabed|tened|id";
    const VOSOTROS = new RegExp(
      `(?<!\\p{L})(?:os|vosotros|vosotras|sois|vais|(?!dieci|veinti)\\p{L}+(?:áis|éis|steis)|${IMPERATIVES})(?!\\p{L})`,
      "iu",
    );
    for (const yes of ["¡Me tenéis manía!", "Ahora os toca a vosotros.", "Una menos. Temblad.", "Tomad nota.", "¡Ya veréis!", "¿Estáis listas, vosotras?", "Sois muy lentos.", "Lo hicisteis a propósito."]) {
      expect(VOSOTROS.test(yes), yes).toBe(true);
    }
    // Ni sustantivos en «-ad», ni numerales en «-éis», ni «os» dentro de otra palabra.
    for (const no of ["verdad", "mitad", "De verdad, qué suerte.", "Ya voy por la mitad.", "Una entre doscientas dieciséis.", "Gracias, cariños."]) {
      expect(VOSOTROS.test(no), no).toBe(false);
    }
    for (const c of [BRAVA, PILAR, CHISPA]) {
      expect(allLines(c).some((l) => /\bustedes\b/i.test(l)), c.name).toBe(false);
    }
    // Brava y Pilar usan el plural de confianza. Chispa no se dirige a varios en ninguna de sus frases (su
    // única coincidencia con la regla anterior era «de verdad»), así que solo se le exige no usar «ustedes».
    for (const c of [BRAVA, PILAR]) {
      expect(allLines(c).some((l) => VOSOTROS.test(l)), c.name).toBe(true);
    }
  });

  it("frases cortas: como mucho dos frases y, de media, menos de 50 caracteres", () => {
    for (const c of CHARACTERS) {
      for (const line of allLines(c)) expect(line.split(/[.!?…]+\s+(?=[A-ZÁÉÍÓÚÑ¡¿{])/u).length, `${c.name}: ${line}`).toBeLessThanOrEqual(2);
      const avg = allLines(c).reduce((s, l) => s + l.length, 0) / allLines(c).length;
      expect(avg, c.name).toBeLessThan(50);
    }
  });
});

describe("frases locales: relacionadas con lo que pasa en la partida", () => {
  /** Vocabulario de cada tipo de evento. Al menos la mitad de las frases de cada tipo debe usarlo. */
  const EVENT: Record<ChatLineKind, RegExp> = {
    victory_win: /gan|primer|victoria|jugad|dado/iu,
    victory_reply: /gan|enhorabuena|felicidades|revancha|jugad|dado|suerte|merecido|próxima|mano/iu,
    capture_boast: /casa|casita|comid|como|comer|fich|pill|captur|tiro|camino|venir|jugada|empezar|siguiente/iu,
    capture_lament: /casa|comid|come|fich|pill|captur|jugada|riesgo|cobro|a por ti|próxima|apunt|visto/iu,
    streak_boast: /captur|casa|casita|otra|van|llevo|caza|\{count\}|\{Count\}/u,
    streak_lament: /captur|casa|casita|otra vez|veces|van|ficha|\{count\}|\{Count\}|lista/u,
    third_six_self: /seis|seises|dado|suerte|castig|turno|regla|penaliz/iu,
    third_six_tease: /seis|seises|dado|suerte|castig|regla|prisa|corr|madera|fortuna/iu,
    goal: /meta|dentro|entra|ficha|salvo|asegurad/iu,
    finish_place: /termin|meta|puesto|fichas|recorrido|listo|hecho|ganado|partida/iu,
    ambient_lead: /voy|ganando|cabeza|primer|ventaja|delante|partida|atrás|meta|distancia/iu,
    ambient_ahead: /partida|tablero|ficha|tirada|movimiento|pelea|atrás|dado|amuleto|madera|llegando|corr|parar|rind/iu,
    ambient_behind: /perdiendo|detrás|alcanzo|remont|seises|dado|corr|margen|ventaja|partida|final|máquina|a por ti|vigilando|largo/iu,
  };

  it("en cada personaje y tipo, al menos la mitad de las frases habla del evento que las provoca", () => {
    for (const c of CHARACTERS) {
      for (const kind of CHAT_LINE_KINDS) {
        const lines = c.chat.lines[kind];
        const related = lines.filter((l) => EVENT[kind].test(l));
        expect(related.length / lines.length, `${c.name}/${kind}: ${lines.filter((l) => !EVENT[kind].test(l)).join(" | ")}`).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it("los comentarios de cada evento no se mezclan: la meta no es la casa, y capturar no es llegar a la meta", () => {
    for (const { c, kind, line } of everyLine()) {
      if (kind.startsWith("capture") || kind.startsWith("streak")) expect(line, `${c.name}/${kind}`).not.toMatch(/\bmeta\b|\bdentro\b/i);
      if (kind === "goal" || kind === "finish_place") expect(line, `${c.name}/${kind}`).not.toMatch(/comid|captur|\bcasa|pill/i);
    }
  });
});

describe("frases locales: cada personaje conserva su personalidad", () => {
  const share = (c: Character, re: RegExp) => allLines(c).filter((l) => re.test(l)).length / allLines(c).length;

  it("Brava: exclamaciones, retos y presunción; Chispa: exclamaciones y superstición con el dado", () => {
    expect(share(BRAVA, /¡/)).toBeGreaterThan(0.4);
    expect(allLines(BRAVA).filter((l) => /a por ti|me la cobro|te vas a enterar|aquí mando|así se juega|ganado a todos|no pienso aflojar|ojo conmigo/i.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(share(CHISPA, /¡/)).toBeGreaterThan(0.4);
    expect(allLines(CHISPA).filter((l) => /dado|suerte|amuleto|mal de ojo|gafe|madera|horóscopo|calcetines/i.test(l)).length).toBeGreaterThanOrEqual(10);
  });

  it("Don Ernesto: sin exclamaciones, de usted y nunca tutea", () => {
    expect(share(ERNESTO, /¡/)).toBe(0);
    expect(allLines(ERNESTO).filter((l) => /\b(usted|ustedes|su|sus|le|les|revise|debería|confunda)\b/i.test(l)).length).toBeGreaterThanOrEqual(8);
    for (const l of allLines(ERNESTO)) expect(l, l).not.toMatch(/(?<!\p{L})(tú|tu|tus|te|ti|contigo|eres|estás|tienes|vas)(?!\p{L})/iu);
    expect(allLines(ERNESTO).filter((l) => /calcul|probabilidad|plan|método|estadístic|una entre/i.test(l)).length).toBeGreaterThanOrEqual(6);
  });

  it("Abuela Pilar: cariñosa y con diminutivos, pero sin convertir cada frase en un refrán", () => {
    expect(share(PILAR, /cariño|hij[oa]s?|cielo|casita|fichita|poquito|despacito/i)).toBeGreaterThan(0.3);
    const REFRANES = /despacito y buena letra|quien ríe el último|no hay mal que por bien no venga|la avaricia rompe el saco|quien mucho corre|quien se pone a tiro|la paciencia es la madre/i;
    expect(share(PILAR, REFRANES)).toBeLessThanOrEqual(0.15);
  });
});

describe("frases locales: sin repetir en exceso las mismas expresiones", () => {
  it("ninguna coletilla aparece en más de dos frases de su personaje", () => {
    for (const c of CHARACTERS) {
      c.catchphrases.forEach((phrase, index) => {
        const uses = allLines(c).filter((l) => detectCatchphrases(c.id, l.replaceAll("{rival}", "Chispa")).includes(index)).length;
        expect(uses, `${c.name}: ${phrase}`).toBeLessThanOrEqual(2);
      });
    }
  });

  it("ningún personaje empieza más de tres frases con las mismas dos palabras", () => {
    const opening = (l: string) => l.toLowerCase().replace(/[¡!¿?….,:]/g, "").split(/\s+/).slice(0, 2).join(" ");
    for (const c of CHARACTERS) {
      const counts = new Map<string, number>();
      for (const l of allLines(c)) counts.set(opening(l), (counts.get(opening(l)) ?? 0) + 1);
      for (const [start, n] of counts) expect(n, `${c.name}: «${start}…»`).toBeLessThanOrEqual(3);
    }
  });
});

describe("frases locales: las que también puede escribir el LLM pasan el validador con los hechos reales", () => {
  // Las capturas y rachas, con cada rival y con rachas de 2 y 3 (seguidas o no), con los hechos que
  // calcula el director (`captureFacts`), y las victorias. El validador no se ha relajado: las frases
  // se han escrito para cumplirlo.
  const cap = (v: number, by: string, victim: string) => ({ v, by, victim });
  const others = (a: string, b: string) => CHARACTERS.map((c) => c.id).filter((id) => id !== a && id !== b);

  /** Historial de una racha de `count` capturas de `by` a `victim`, seguidas o con capturas ajenas entre medias. */
  const streakLog = (by: string, victim: string, count: number, consecutive: boolean) => {
    const [x, y] = others(by, victim);
    const log: ReturnType<typeof cap>[] = [];
    let v = 10;
    for (let i = 0; i < count; i++) {
      if (i > 0 && !consecutive) log.push(cap(v++, x, y));
      log.push(cap(v++, by, victim));
    }
    return log;
  };

  it("capturas, rachas y victorias de los cuatro personajes con todos sus rivales", () => {
    let checked = 0;
    for (const c of CHARACTERS) {
      for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
        const cases: { kind: ChatLineKind; u: Utterance }[] = [];
        for (const kind of ["capture_boast", "capture_lament"] as const) {
          const [by, victim] = kind === "capture_boast" ? [c.id, rival.id] : [rival.id, c.id];
          const log = [cap(10, by, victim)];
          cases.push({ kind, u: { speaker: c.id, kind, rival: rival.id, trigger: "capture", replyTo: null, important: true, captures: captureFacts(log, 10, by, victim, c.id) } });
        }
        for (const count of [2, 3]) {
          for (const consecutive of [true, false]) {
            if (count === 2 && !consecutive) continue; // dos capturas no seguidas no son racha
            for (const kind of ["streak_boast", "streak_lament"] as const) {
              const [by, victim] = kind === "streak_boast" ? [c.id, rival.id] : [rival.id, c.id];
              const log = streakLog(by, victim, count, consecutive);
              const last = log[log.length - 1];
              const trigger = kind === "streak_boast" ? "capture_streak" : "bad_streak";
              cases.push({ kind, u: { speaker: c.id, kind, rival: rival.id, trigger, replyTo: null, important: true, streak: { count, consecutive }, captures: captureFacts(log, last.v, by, victim, c.id) } });
            }
          }
        }
        cases.push({ kind: "victory_reply", u: { speaker: c.id, kind: "victory_reply", rival: rival.id, trigger: "victory", replyTo: null, important: true } });
        for (const { kind, u } of cases) {
          for (const line of c.chat.lines[kind]) {
            const text = renderLine(line, u);
            expect(text, `${c.name}/${kind}: ${line}`).not.toBeNull();
            expect(checkQuality(text!, { utterance: u, recent: [], replyToText: null }), `${c.name}/${kind} (${JSON.stringify(u.streak ?? null)}): ${text}`).toBeNull();
            checked++;
          }
        }
      }
      const win: Utterance = { speaker: c.id, kind: "victory_win", rival: null, trigger: "victory", replyTo: null, important: true };
      for (const line of c.chat.lines.victory_win) {
        expect(checkQuality(renderLine(line, win)!, { utterance: win, recent: [], replyToText: null }), `${c.name}/victory_win: ${line}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500); // 536 frases rellenadas
  });
});

describe("frases locales: sin las expresiones artificiales de la partida de Preview", () => {
  // Preguntas retóricas de narrador, peticiones al dado, solemnidad y metáforas, y muletillas de liderazgo.
  const ARTIFICIAL_PATTERNS: readonly [string, RegExp][] = [
    ["pregunta retórica de liderazgo", /¿qui[eé]n me sigue|¿esto es todo lo que ten[eé]is/iu],
    ["petición al dado", /\b(?:dadme|dame|deme|danos)\s+(?:un|ese|el|otro)\s+(?:seis|cinco)\b|(?:seis|dado)[^.!?…]*por favor/iu],
    ["golpe", /(?<![\p{L}])(?<!de\s)golpes?(?![\p{L}])(?!\s+de\s+suerte)/iu],
    ["solemnidad", /da sus frutos|presi[oó]n constante/iu],
    ["muletilla de liderazgo", /sin frenar|no pienso aflojar|tengo que ganar/iu],
    ["objetivo ordinal", /\bpor la (?:segunda|tercera|cuarta|quinta)\b(?!\s+(?:vez|captura|ficha))/iu],
    ["frase suelta sin acontecimiento", /no me la quites/iu],
  ];

  it("ninguna frase local contiene esos patrones", () => {
    for (const { c, kind, line } of everyLine()) {
      for (const [name, re] of ARTIFICIAL_PATTERNS) expect(re.test(line), `${c.name}/${kind} (${name}): ${line}`).toBe(false);
    }
  });

  it("las frases corregidas: Brava sin preguntas retóricas de liderazgo y Don Ernesto sin solemnidad", () => {
    expect(BRAVA.chat.lines.ambient_lead).toContain("Voy delante. Así me gusta.");
    expect(BRAVA.chat.lines.ambient_lead).toContain("Voy en cabeza. Hoy me salen las tiradas.");
    expect(BRAVA.chat.lines.ambient_ahead).toContain("Sigo aquí, y con ganas.");
    expect(ERNESTO.chat.lines.streak_boast).toContain("Le he vuelto a comer, {rival}. Era de esperar.");
  });
});

describe("frases locales: el género de los apelativos concuerda con el destinatario", () => {
  it("ninguna frase de ningún personaje, con ningún rival, usa un apelativo del género contrario al del destinatario", () => {
    const streak = { count: 2, consecutive: true };
    let checked = 0;
    for (const { c, kind, line } of everyLine()) {
      for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
        const u = { speaker: c.id, kind, rival: rival.id, trigger: "capture", replyTo: null, important: true, streak } as Utterance;
        const text = renderLine(line, u);
        if (text === null) continue;
        checked++;
        expect(checkQuality(text, { utterance: u, recent: [], replyToText: null })?.reason, `${c.name} → ${rival.name} (${kind}): ${text}`).not.toBe(
          "no concuerda el género del destinatario",
        );
      }
    }
    expect(checked).toBeGreaterThan(600); // 690 combinaciones de frase y rival con el catálogo actual
  });

  it("todos los personajes tienen género, y el de cada uno es el previsto", () => {
    expect(Object.fromEntries(CHARACTERS.map((c) => [c.name, c.gender]))).toEqual({ Brava: "f", "Don Ernesto": "m", "Abuela Pilar": "f", Chispa: "m" });
  });
});

describe("prompt: registro de España, la situación real y el nombre «Abuela»", () => {
  const request = (speaker: string, rival: string | null, kind: ChatLineKind = "capture_boast") => ({
    utterance: { speaker, kind, rival, trigger: "capture", replyTo: null, important: true } as Utterance,
    recent: [],
    replyToText: null,
  });

  it("pide español coloquial de España, vocabulario del parchís y reaccionar solo a lo que acaba de pasar", () => {
    for (const c of CHARACTERS) {
      const [system] = buildChatPrompt(request(c.id, c.id === "ai-blue" ? "ai-pink" : "ai-blue"));
      expect(system.content).toMatch(/como se habla en España jugando al parchís/);
      expect(system.content).toMatch(/ficha, dado, comer, casa, meta, seis, turno/);
      expect(system.content).toContain("Reacciona solo a lo que acaba de pasar.");
      expect(system.content).toContain("- Di claro qué ha pasado («te comí», «me comiste», «te comió»). Sin preguntas retóricas, peticiones al dado ni «voy primero».");
      expect(system.content).toContain("no inventes jugadas, cifras, posiciones ni rachas");
      expect(system.content).not.toMatch(/señores|comentarista|retransmi|partido|deport/i);
    }
  });

  it("permite llamar «Abuela» a Abuela Pilar cuando es la otra parte; a Pilar no se le sugiere llamar abuela a nadie", () => {
    for (const c of [BRAVA, ERNESTO, CHISPA]) {
      const [system] = buildChatPrompt(request(c.id, PILAR.id));
      expect(system.content, c.name).toContain("A Abuela Pilar también puedes llamarla «Abuela».");
    }
    expect(buildChatPrompt(request(PILAR.id, BRAVA.id))[0].content).not.toContain("«Abuela»");
    expect(buildChatPrompt(request(BRAVA.id, CHISPA.id))[0].content).not.toContain("«Abuela»");
  });

  // Flujo real del escritor LLM: `cleanLlmText` (nombres y alias permitidos en la intervención, que solo
  // comprueba esta función) y, sobre su resultado, `checkQuality`.
  const TEXTS = ["¡Lo siento, Abuela! Esa ficha vuelve a casa.", "Lo siento, Abuela Pilar. Esa ficha vuelve a casa."];

  it("el validador acepta «Abuela» y «Abuela Pilar» cuando Pilar participa en la intervención", () => {
    for (const c of [BRAVA, ERNESTO, CHISPA]) {
      const req = request(c.id, PILAR.id);
      for (const raw of TEXTS) {
        const text = cleanLlmText(raw, req);
        expect(text, `${c.name}: ${raw}`).toBe(raw);
        expect(checkQuality(text, req), `${c.name}: ${raw}`).toBeNull();
      }
    }
  });

  it("el validador rechaza «Abuela» y «Abuela Pilar» cuando Pilar no participa en la intervención", () => {
    for (const [speaker, rival] of [
      [BRAVA, CHISPA],
      [ERNESTO, BRAVA],
      [CHISPA, ERNESTO],
    ] as const) {
      for (const raw of TEXTS) {
        let error: unknown = null;
        try {
          cleanLlmText(raw, request(speaker.id, rival.id));
        } catch (e) {
          error = e;
        }
        expect(error, `${speaker.name} → ${rival.name}: ${raw}`).toBeInstanceOf(ChatLlmError);
        expect((error as ChatLlmError).message).toBe("nombra a un personaje ajeno a la intervención");
      }
    }
  });
});
