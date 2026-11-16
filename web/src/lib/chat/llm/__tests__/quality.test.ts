import { describe, expect, it } from "vitest";
import { CHARACTERS } from "@/lib/game/characters";
import { captureFacts, type Utterance } from "../../director";
import type { RecentText } from "../../writer";
import type { ChatTrigger } from "../../schemas";
import { ChatLlmError, cleanLlmText, INVALID_RESPONSE_REASONS } from "../gatewayWriter";
import { OTHER_GAMES, QUALITY_REASONS, SPORTS_METAPHORS, checkQuality, countSentences, disallowedDiminutive, hasDiscardedExpression } from "../quality";
import { buildChatPrompt } from "../prompt";

const say = (speaker: string, rival: string | null, extra: Partial<Utterance> = {}, recent: RecentText[] = [], usedCatchphrases?: number[]) => ({
  utterance: { speaker, kind: "capture_boast", rival, trigger: "capture", replyTo: null, important: true, ...extra } as Utterance,
  recent,
  replyToText: null,
  ...(usedCatchphrases ? { usedCatchphrases } : {}),
});
type Request = ReturnType<typeof say>;

/** Una captura del historial del director (`{ v, by, victim }`). */
const cap = (v: number, by: string, victim: string) => ({ v, by, victim });
/**
 * Los hechos de captura REALES que calcula el director (`captureFacts`) para `speaker`, a partir de un
 * historial cuya última captura es la de esta versión.
 */
const factsOf = (log: ReturnType<typeof cap>[], speaker: string) => {
  const last = log[log.length - 1];
  return captureFacts(log, last.v, last.by, last.victim, speaker);
};

/** Motivo y diagnóstico del rechazo, o `null` si se acepta. */
function reject(text: string, request: Request): { reason: string; detail?: string } | null {
  try {
    cleanLlmText(text, request);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatLlmError);
    const e = error as ChatLlmError;
    expect(e.kind).toBe("invalid_response");
    return { reason: e.message, detail: e.detail };
  }
}

describe("regresión: mensajes problemáticos de la partida de Preview 707c3c6d…", () => {
  it("#5 Pilar mezcla español e inglés", () => {
    const r = reject("Despacito y buena letra, Don Ernesto. Who laughs last laughs best.", say("ai-green", "ai-purple", { kind: "capture_lament" }));
    expect(r).toEqual({ reason: "idioma no permitido", detail: "termino=who laughs last" });
  });

  it("#18 Chispa llama «la abuela Brava» a Brava (confunde personajes)", () => {
    const text = "¡Qué racha de mala suerte! Con este dado ni la abuela Brava se salva.";
    // Abuela Pilar no participa: «la abuela» la identifica, así que es una mención ajena.
    expect(reject(text, say("ai-blue", "ai-pink", { kind: "capture_lament" }))).toEqual({
      reason: "nombra a un personaje ajeno a la intervención",
      detail: "nombre=Abuela Pilar coincidencia=alias:abuela",
    });
    // Aunque Pilar participara, «abuela Brava» mezcla dos personajes.
    expect(reject("Con este dado ni la abuela Brava se salva.", say("ai-green", "ai-pink", { kind: "capture_lament" }))).toEqual({
      reason: "mezcla nombres de personajes",
      detail: "termino=abuela brava",
    });
  });

  it("#23 Chispa habla de «racha» en una captura simple (afirmación no respaldada y contradictoria)", () => {
    expect(reject("¡Mala racha, Don Ernesto! Hoy no es mi día.", say("ai-blue", "ai-purple"))).toEqual({
      reason: "afirmación no respaldada",
      detail: "termino=racha",
    });
  });

  it("#11 Don Ernesto tutea", () => {
    expect(reject("Previsible. Tu suerte se agota, pero no la mía.", say("ai-purple", "ai-green"))).toEqual({
      reason: "tutea (Don Ernesto)",
      detail: "termino=tu",
    });
  });

  it("#10 y #24 Brava repite «¡A casa!» cuando ya la ha dicho hace poco; la primera vez se acepta", () => {
    const history = [{ speaker: "ai-pink", text: "¡A casa!" }, { speaker: "ai-blue", text: "¡Y el dado dice…!" }];
    // El caso real (#24) es tan parecido a «¡A casa!» que ya lo rechaza la antirrepetición existente.
    expect(reject("¡A casa, Don Ernesto!", say("ai-pink", "ai-purple", {}, history))?.reason).toBe("texto repetido o no válido");
    // La regla nueva cubre la coletilla copiada dentro de una frase distinta, que la similitud no detecta.
    const text = "¡A casa, Don Ernesto! Hoy reparto más fichas que un cartero.";
    expect(reject(text, say("ai-pink", "ai-purple"))).toBeNull(); // la primera vez, se acepta
    expect(reject(text, say("ai-pink", "ai-purple", {}, history))).toEqual({
      reason: "expresión característica repetida",
      detail: "termino=¡A casa!",
    });
    // La dijo otro personaje: no cuenta como repetición de Brava.
    expect(reject(text, say("ai-pink", "ai-purple", {}, [{ speaker: "ai-blue", text: "¡A casa!" }]))).toBeNull();
  });

  it("#13 Brava usa «tres en raya» y afirma que Chispa «ya casi está fuera»", () => {
    const streak = { kind: "streak_boast" as const, trigger: "capture_streak" as const, streak: { count: 3, consecutive: true } };
    expect(reject("¡Tres en raya! Chispa, ya casi estás fuera.", say("ai-pink", "ai-blue", streak))).toEqual({
      reason: "expresión ajena al parchís",
      detail: "termino=tres en raya",
    });
    expect(reject("¡Tres capturas! Chispa, ya casi estás fuera.", say("ai-pink", "ai-blue", streak))).toEqual({
      reason: "afirmación no respaldada",
      detail: "termino=estas fuera",
    });
  });
});

describe("mensajes naturales que se siguen aceptando", () => {
  const ok = (text: string, request: Request) => expect(reject(text, request), text).toBeNull();

  it("los demás mensajes del LLM de esa partida pasan (rachas en intervenciones de racha, coletilla la primera vez)", () => {
    const badStreak = { kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count: 2, consecutive: true } };
    // Pilar llamaba «mi niña» a Chispa (masculino): ahora se rechaza por el género del destinatario. Con
    // el apelativo que le corresponde, el mismo mensaje se acepta.
    expect(checkQuality("Ay, mi niña, con dos seguidas ya es castigo divino. Quien mucho abarca, poco aprieta.", say("ai-green", "ai-blue", badStreak))).toEqual({
      reason: "no concuerda el género del destinatario",
      term: "niña (Chispa: masculino)",
    });
    ok("Ay, mi niño, con dos seguidas ya es castigo divino. Quien mucho abarca, poco aprieta.", say("ai-green", "ai-blue", badStreak));
    // Réplica (capture_lament) dentro de una racha: «racha» está respaldada por el disparador.
    ok("¡Chas! Me has pillado con la racha mala.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }));
    // Con tres frases, ahora se rechaza por longitud (regla de como mucho dos frases).
    expect(reject("¡Chas! Me has pillado con la racha mala. Un paso atrás para mí.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }))?.reason).toBe(
      "demasiadas frases",
    );
    // El original («… para la Chispa») habla de sí misma en tercera persona: ahora se rechaza (regla B).
    // (En dos frases, para que lo rechace la regla B y no la de longitud.)
    expect(reject("¡Chas! Un paso atrás para la Chispa.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }))?.reason).toBe(
      "habla de sí mismo en tercera persona",
    );
    // «Estadísticamente era inevitable» (coletilla de entonces) se retiró del catálogo por artificial: ahora se rechaza.
    expect(checkQuality("Estadísticamente era inevitable.", say("ai-purple", "ai-green", { replyTo: 0 }))).toEqual({ reason: "expresión poco natural", term: "coletilla retirada" });
    ok("Previsible.", say("ai-purple", "ai-green", { replyTo: 0 }));
    ok("¡Toma ya! No me toques la fibra.", say("ai-pink", "ai-blue", { replyTo: 0 }));
    ok("¡A casa!", say("ai-pink", "ai-blue", { kind: "streak_boast", trigger: "capture_streak" }));
  });

  it("Don Ernesto de usted, con citas o tuteo ajeno entre comillas, y demostrativos sin tilde", () => {
    ok("Le ha faltado cálculo, Abuela Pilar. Su ficha regresa a casa, como estaba previsto.", say("ai-purple", "ai-green"));
    ok("Brava gritaba «¡voy a por ti!», pero su ficha ya está en casa.", say("ai-purple", "ai-pink"));
    ok("Estas fichas no mienten, Chispa: usted arriesgó demasiado.", say("ai-purple", "ai-blue"));
    ok("Como dice el refrán: no por mucho madrugar amanece más temprano. Usted lo sabe, Brava.", say("ai-purple", "ai-pink"));
  });

  it("«abuela» genérica no es una mención a Pilar; con Pilar en la intervención, «la abuela» se acepta", () => {
    ok("Juego como mi abuela: con calma y buena suerte.", say("ai-blue", "ai-pink"));
    ok("Ni una abuela con prisas corre tanto, Brava.", say("ai-blue", "ai-pink"));
    ok("¡La abuela se lleva un susto! A casa esa ficha.", say("ai-blue", "ai-green"));
    ok("Ay, cariño, esa ficha vuelve a su casita. Sin prisa se llega lejos, Chispa.", say("ai-green", "ai-blue"));
  });

  it("expresiones naturales de competición y préstamos sueltos", () => {
    ok("¡Voy a por ti, Don Ernesto! Esta partida es mía.", say("ai-blue", "ai-purple"));
    ok("¡Has perdido una ficha, Brava! Vuelve a empezar.", say("ai-blue", "ai-pink"));
    ok("Es la primera vez que me pasa, ¡qué escándalo!", say("ai-blue", "ai-pink", { kind: "capture_lament" }));
    ok("¡Qué crack eres, Brava! Menudo show.", say("ai-blue", "ai-pink", { kind: "capture_lament" }));
    ok("Ni en el mejor game de la tele se ve esto, Chispa.", say("ai-pink", "ai-blue"));
    ok("¡Vuelve a casa, Chispa! ¿Quién se atreve ahora?", say("ai-pink", "ai-blue", {}, [{ speaker: "ai-pink", text: "¡A casa!" }]));
    ok("¡He ganado la partida! ¿Quién quiere la revancha?", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }));
  });
});

describe("cada regla nueva por separado", () => {
  it("idioma: expresiones inglesas inequívocas, contracciones y dos palabras inglesas; no una sola", () => {
    expect(checkQuality("¡Game over, Chispa!", say("ai-pink", "ai-blue"))).toEqual({ reason: "idioma no permitido", term: "game over" });
    expect(checkQuality("¡Let's go, Chispa!", say("ai-pink", "ai-blue"))?.reason).toBe("idioma no permitido");
    expect(checkQuality("It’s mi turno, Chispa.", say("ai-pink", "ai-blue"))?.reason).toBe("idioma no permitido");
    expect(checkQuality("Good game, Brava.", say("ai-blue", "ai-pink"))).toEqual({ reason: "idioma no permitido", term: "good+game" });
    expect(checkQuality("Buen game, Brava.", say("ai-blue", "ai-pink"))).toBeNull();
  });

  it("nombres: alias de ajenos («Ernesto», «Pilar»), tratamientos cruzados y nombres propios permitidos", () => {
    expect(reject("Ernesto, mire cómo vuelve su ficha.", say("ai-blue", "ai-pink"))).toEqual({
      reason: "nombra a un personaje ajeno a la intervención",
      detail: "nombre=Don Ernesto coincidencia=alias:ernesto",
    });
    expect(reject("Ojo con Pilar, que viene despacito.", say("ai-blue", "ai-pink"))?.detail).toBe("nombre=Abuela Pilar coincidencia=alias:pilar");
    expect(checkQuality("¡Don Chispa, qué susto!", say("ai-blue", "ai-pink"))).toEqual({ reason: "mezcla nombres de personajes", term: "don chispa" });
    expect(checkQuality("¡Doña Brava, a casa!", say("ai-blue", "ai-pink"))).toEqual({ reason: "mezcla nombres de personajes", term: "doña brava" });
    // Los alias de quien participa sí se pueden usar.
    expect(reject("Pilar, ha sido una buena jugada.", say("ai-purple", "ai-green"))).toBeNull();
    expect(reject("Abuela Pilar, te he pillado.", say("ai-blue", "ai-green"))).toBeNull();
  });

  it("usted: solo afecta a Don Ernesto", () => {
    for (const word of ["tú", "te", "ti", "contigo", "tienes", "has", "vas", "eres", "estás"]) {
      expect(checkQuality(`Lo siento, ${word} lo verá.`, say("ai-purple", "ai-pink"))?.reason, word).toBe("tutea (Don Ernesto)");
    }
    expect(checkQuality("Te toca, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
  });

  it("ajeno al parchís y afirmaciones sobre la partida", () => {
    for (const [text, term] of [
      ["¡Jaque mate, Chispa!", "jaque mate"],
      ["Esto es un golazo, Chispa.", "gol"], // derivado de «gol»
      ["Tarjeta roja para ti, Chispa.", "tarjeta roja"],
    ] as const) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toEqual({ reason: "expresión ajena al parchís", term });
    }
    for (const text of ["Voy ganando, Chispa.", "Chispa, vas el último.", "Estás a punto de perder, Chispa.", "¡He ganado!", "Chispa ha perdido la partida.", "Ya estás eliminada, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue"))?.reason, text).toBe("afirmación no respaldada");
    }
    expect(checkQuality("¡Llevo tres seguidas!", say("ai-pink", "ai-blue", { kind: "streak_boast", trigger: "capture_streak", streak: { count: 3, consecutive: true } }))).toBeNull();
    expect(checkQuality("¡Has ganado, Brava!", say("ai-blue", "ai-pink", { kind: "victory_reply", trigger: "victory" }))).toBeNull();
  });

  it("nadie usa metáforas deportivas ni reglas de otros juegos, tampoco Chispa (ya no es «comentarista»)", () => {
    // Antes se le permitían a Chispa; ahora se rechazan por el flujo completo, como a los demás.
    for (const text of ["¡Golazo por la escuadra! Brava, a casa a por agua.", "¡Gol! Qué jugada, Brava.", "¡Triple sobre la bocina, Brava!", "¡Canasta desde casa! Brava, a empezar de nuevo.", "¡Fuera de juego, Brava!"]) {
      expect(reject(text, say("ai-blue", "ai-pink"))?.reason, text).toBe("expresión ajena al parchís");
    }
  });

  // Cada término por separado, en una frase que no contiene ningún otro término de las listas.
  const sentence = (term: string) => `Eso ha sido ${term}, compañero.`;
  const COMMENTATOR = "ai-blue"; // Chispa, a quien antes se le permitían las metáforas deportivas
  const OTHERS = ["ai-pink", "ai-purple", "ai-green"] as const;

  it("la frase de prueba, sin término, se acepta para los cuatro (sin falsos positivos)", () => {
    for (const speaker of [COMMENTATOR, ...OTHERS]) {
      expect(checkQuality("Eso ha sido increíble, compañero.", say(speaker, speaker === COMMENTATOR ? "ai-pink" : COMMENTATOR)), speaker).toBeNull();
    }
  });

  it.each(SPORTS_METAPHORS.map((term) => [term]))("metáfora deportiva «%s»: los cuatro personajes, incluida Chispa, la rechazan", (term) => {
    // «golazo» es un derivado de «gol» y se informa como «gol».
    const expected = term === "golazo" ? "gol" : term;
    for (const speaker of [COMMENTATOR, ...OTHERS]) {
      expect(checkQuality(sentence(term), say(speaker, speaker === COMMENTATOR ? "ai-pink" : COMMENTATOR)), speaker).toEqual({ reason: "expresión ajena al parchís", term: expected });
    }
  });

  it.each(OTHER_GAMES.map((term) => [term]))("otro juego «%s»: los cuatro personajes, incluida Chispa, lo rechazan con ese término", (term) => {
    for (const speaker of [COMMENTATOR, ...OTHERS]) {
      expect(checkQuality(sentence(term), say(speaker, speaker === COMMENTATOR ? "ai-pink" : COMMENTATOR)), speaker).toEqual({ reason: "expresión ajena al parchís", term });
    }
  });

  it("«jaque mate» se informa como tal, no como «jaque»", () => {
    expect(checkQuality("¡Jaque mate, Brava!", say(COMMENTATOR, "ai-pink"))).toEqual({ reason: "expresión ajena al parchís", term: "jaque mate" });
    expect(checkQuality("¡Jaque, Brava!", say(COMMENTATOR, "ai-pink"))).toEqual({ reason: "expresión ajena al parchís", term: "jaque" });
  });

  // ── A. Variantes de coletillas ──
  it("A: «¡A casa!» y «¡A casa con eso, Chispa!» son la misma coletilla, en los dos órdenes", () => {
    const brava = (recent: RecentText[]) => say("ai-pink", "ai-blue", {}, recent);
    // Primero «¡A casa con eso…», después «¡A casa!» (el caso de la partida 1deb3d7a…).
    expect(reject("¡A casa!", brava([{ speaker: "ai-pink", text: "¡A casa con eso, Chispa!" }]))).toEqual({
      reason: "expresión característica repetida",
      detail: "termino=¡A casa!",
    });
    // Y al revés.
    expect(reject("¡A casa con eso, Chispa!", brava([{ speaker: "ai-pink", text: "¡A casa!" }]))).toEqual({
      reason: "expresión característica repetida",
      detail: "termino=¡A casa!",
    });
    // Sin historial, las dos se aceptan; y si la dijo otro personaje, tampoco cuenta.
    expect(reject("¡A casa con eso, Chispa!", brava([]))).toBeNull();
    expect(reject("¡A casa con eso, Chispa!", brava([{ speaker: "ai-blue", text: "¡A casa!" }]))).toBeNull();
  });

  it("A: «a casa» dentro de una frase normal no es la coletilla («Vuelve a casa», «Esa ficha va a casa»)", () => {
    const history = [{ speaker: "ai-pink", text: "¡A casa con eso, Chispa!" }];
    expect(reject("Vuelve a casa, Chispa, y empieza otra vez.", say("ai-pink", "ai-blue", {}, history))).toBeNull();
    expect(reject("Esa ficha va a casa, Chispa. Siguiente.", say("ai-pink", "ai-blue", {}, history))).toBeNull();
    // Otras coletillas con palabras de más también cuentan (Chispa, Don Ernesto).
    expect(checkQuality("¡Qué mala pata, Brava!", say("ai-blue", "ai-pink", {}, [{ speaker: "ai-blue", text: "¡Qué mala pata! Otra vez será." }]))?.term).toBe("¡Qué mala pata!");
    expect(checkQuality("Previsible jugada, Chispa.", say("ai-purple", "ai-blue", {}, [{ speaker: "ai-purple", text: "Previsible, como siempre." }]))?.term).toBe("Previsible");
  });

  // ── B. Tercera persona propia: narración de su propia frase (auditoría de la v382) ──
  it("B: rechaza que el personaje narre su propia frase («dijo Pilar», «dice Chispa», «Brava dijo»), con nombre o alias", () => {
    for (const [speaker, rival, text, term] of [
      ["ai-green", "ai-blue", "Ay, Chispa, a casita, dijo Pilar.", "narración+pilar"],
      ["ai-green", "ai-blue", "Qué pena, Chispa, dice Abuela Pilar.", "narración+abuela pilar"],
      ["ai-blue", "ai-pink", "¡Ostras, Brava!, exclamó Chispa.", "narración+chispa"],
      ["ai-pink", "ai-blue", "Brava dijo: ¡a casa, Chispa!", "narración+brava"],
      ["ai-purple", "ai-pink", "Previsible, contestó Don Ernesto a Brava.", "narración+don ernesto"],
      ["ai-purple", "ai-pink", "Era de esperar, Brava, respondió Ernesto.", "narración+ernesto"],
    ] as const) {
      expect(checkQuality(text, say(speaker, rival)), text).toEqual({ reason: "habla de sí mismo en tercera persona", term });
    }
  });

  it("B: la narración de otro personaje o los verbos de habla sin el propio nombre se siguen aceptando", () => {
    expect(reject("Ya lo dijo Chispa: hoy no es mi día.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Chispa dice que tiene suerte. Ya veremos, cariño.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Como dice mi nieto, a casita, Chispa.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Lo que te dije, Chispa: a casa.", say("ai-pink", "ai-blue"))).toBeNull();
  });

  // ── B. Tercera persona propia ──
  it("B: rechaza que cada personaje hable de sí mismo en tercera persona (artículo o verbo), con nombre o alias", () => {
    for (const [speaker, rival, text, term] of [
      ["ai-blue", "ai-pink", "Un paso atrás para la Chispa.", "artículo+chispa"],
      ["ai-blue", "ai-pink", "¡Chispa ha caído, pero vuelve!", "chispa+verbo"],
      ["ai-pink", "ai-blue", "Aquí manda la Brava, Chispa.", "artículo+brava"],
      ["ai-pink", "ai-blue", "Brava nunca falla, Chispa.", "brava+verbo"],
      ["ai-purple", "ai-blue", "Don Ernesto nunca se equivoca, Chispa.", "don ernesto+verbo"],
      ["ai-purple", "ai-blue", "Ernesto sabe lo que hace, Chispa.", "ernesto+verbo"],
      ["ai-purple", "ai-blue", "Pregunte usted al Ernesto, Chispa.", "artículo+ernesto"],
      ["ai-green", "ai-blue", "Pilar no se rinde, cariño.", "pilar+verbo"],
      ["ai-green", "ai-blue", "Con la Abuela Pilar no se juega, cariño.", "artículo+abuela pilar"],
    ] as const) {
      expect(checkQuality(text, say(speaker, rival)), text).toEqual({ reason: "habla de sí mismo en tercera persona", term });
    }
  });

  it("B: nadie dice su propio nombre (tampoco para presentarse); nombrar a los rivales en tercera persona sí", () => {
    // Antes se aceptaban; ahora el propio nombre no aparece en ninguna construcción.
    expect(reject("¡Otra para Chispa! Qué jugada.", say("ai-blue", "ai-pink"))).toMatchObject({ reason: "se nombra a sí mismo", detail: "termino=chispa" });
    expect(reject("Soy Brava y nunca fallo, Chispa.", say("ai-pink", "ai-blue"))).toMatchObject({ reason: "se nombra a sí mismo", detail: "termino=brava" });
    expect(reject("Le habla Don Ernesto: era previsible, Chispa.", say("ai-purple", "ai-blue"))).toMatchObject({ reason: "se nombra a sí mismo", detail: "termino=don ernesto" });
    // Rivales en tercera persona (con artículo o verbo): no es hablar de sí mismo.
    expect(reject("¡Brava ha caído! Y el dado lo ha visto.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡La abuela se lleva un susto! A casa esa ficha.", say("ai-blue", "ai-green"))).toBeNull();
    expect(reject("Chispa no aprende, cariño.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Don Ernesto nunca se rinde, ya lo sé.", say("ai-blue", "ai-purple"))).toBeNull();
    // Pilar llamándose «la abuela» es parte de su personaje (sus frases locales lo usan).
    expect(reject("Ay, la abuela no corre tanto, Chispa.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Felicidades, Chispa. A la próxima, la abuela se pone seria.", say("ai-green", "ai-blue", { kind: "victory_reply", trigger: "victory" }))).toBeNull();
    // Palabras comunes: «abuela» genérica dicha por Pilar y «brava» como adjetivo dicha por Brava.
    expect(reject("Mi abuela siempre decía: sin prisa, cariño.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("¡Qué jugada más brava, Chispa!", say("ai-pink", "ai-blue"))).toBeNull();
  });

  // ── D. Cifras de capturas ──
  const streakOf = (count: number, consecutive = false) => ({ kind: "streak_boast" as const, trigger: "capture_streak" as const, streak: { count, consecutive } });

  it("D: en una racha, las cifras deben coincidir con el recuento real (en palabras o en cifras)", () => {
    for (const text of ["¡Tres capturas, Chispa! Estoy imparable.", "¡3 capturas en poco tiempo, Chispa!"]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue", streakOf(3))), text).toBeNull();
    }
    // «seguidas» solo si la racha fue de capturas consecutivas.
    expect(checkQuality("Van tres seguidas, Chispa.", say("ai-pink", "ai-blue", streakOf(3, true)))).toBeNull();
    expect(checkQuality("¡Cuatro capturas, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))).toEqual({ reason: "afirmación no respaldada", term: "cifra 4 (real 3)" });
    expect(checkQuality("¡5 capturas, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))).toEqual({ reason: "afirmación no respaldada", term: "cifra 5 (real 3)" });
    const lament = { kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count: 2, consecutive: true } };
    expect(checkQuality("Ay, dos veces seguidas, cariño.", say("ai-green", "ai-blue", lament))).toBeNull();
    // «me has pillado» habla de la pareja (Chispa → Pilar), no de la mala racha: sin ese dato, no verificable.
    expect(checkQuality("Ay, me has pillado tres veces ya, cariño.", say("ai-green", "ai-blue", lament))).toEqual({ reason: "afirmación no respaldada", term: "cifra 3 (sin datos, del rival a quien habla)" });
    // Sin señal de captura en la frase, «veces» no se interpreta como cifra de capturas (límite asumido).
    expect(checkQuality("Ay, tres veces ya, cariño.", say("ai-green", "ai-blue", lament))).toBeNull();
  });

  it("D: fuera de una racha (o en una réplica sin recuento) solo se admite «una captura»", () => {
    expect(checkQuality("¡Una captura limpia, Chispa!", say("ai-pink", "ai-blue"))).toBeNull();
    expect(checkQuality("¡Dos capturas, Chispa!", say("ai-pink", "ai-blue"))).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
    expect(checkQuality("Me has pillado tres veces, Brava.", say("ai-blue", "ai-pink", { kind: "capture_lament" }))).toEqual({
      reason: "afirmación no respaldada",
      term: "cifra 3 (sin datos, del rival a quien habla)",
    });
    // Réplica dentro de una racha: no lleva el recuento, así que no puede dar cifras.
    const reply = { kind: "capture_lament" as const, trigger: "capture_streak" as const, replyTo: 0 };
    expect(checkQuality("Tres capturas, sí, Brava.", say("ai-blue", "ai-pink", reply))?.term).toBe("cifra 3 (real sin racha)");
  });

  it("D (auditoría): «seguidas» con una racha no consecutiva, con cifra o sin ella, se rechaza", () => {
    expect(checkQuality("¡Tres seguidas, Chispa!", say("ai-pink", "ai-blue", streakOf(3, false)))).toEqual({ reason: "afirmación no respaldada", term: "seguidas (real en poco tiempo)" });
    expect(checkQuality("¡Y van seguidas, Chispa!", say("ai-pink", "ai-blue", streakOf(3, false)))).toEqual({ reason: "afirmación no respaldada", term: "seguidas (real en poco tiempo)" });
    expect(checkQuality("¡Y van seguidas, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))).toBeNull();
    // Mala racha: el recuento y el ritmo son los de las veces que le han capturado.
    const hunted = (count: number, consecutive: boolean) => ({ kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count, consecutive } });
    expect(checkQuality("Ay, dos veces en poco tiempo, cariño.", say("ai-green", "ai-blue", hunted(2, false)))).toBeNull();
    expect(checkQuality("Ay, dos seguidas, cariño.", say("ai-green", "ai-blue", hunted(2, false)))?.term).toBe("seguidas (real en poco tiempo)");
  });

  it("D (auditoría): «una captura» habla de la que acaba de ocurrir: se admite en capturas, rachas y réplicas, no en la victoria", () => {
    expect(checkQuality("Una captura no es nada, Brava.", say("ai-blue", "ai-pink", { kind: "capture_lament", replyTo: 0 }))).toBeNull();
    expect(checkQuality("¡Una captura más, Chispa! Imparable.", say("ai-pink", "ai-blue", streakOf(3)))).toBeNull();
    expect(checkQuality("¡Una captura y gané, Chispa!", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }))).toEqual({
      reason: "afirmación no respaldada",
      term: "cifra 1 (real sin racha)",
    });
    // «la primera vez» no cuenta capturas: se admite siempre, también en la victoria.
    expect(checkQuality("¡Es la primera vez que gano, señores!", say("ai-blue", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
  });

  it("D (auditoría): ordinales, números mayores que diez, «un par de» y un adjetivo intercalado", () => {
    // Ordinales: deben coincidir con el recuento real.
    expect(checkQuality("¡Mi tercera captura, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))).toBeNull();
    expect(checkQuality("¡Mi tercera captura, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))?.term).toBe("cifra 3 (real 2, hechas por quien habla)");
    expect(checkQuality("¡Mi tercera captura, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 3 (sin datos, hechas por quien habla)");
    const hunted2 = { kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count: 2, consecutive: true } };
    expect(checkQuality("Por segunda vez, Chispa. Me la apunto.", say("ai-pink", "ai-blue", hunted2))).toBeNull();
    // Números mayores que diez y «un par de».
    expect(checkQuality("¡Once capturas, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))?.term).toBe("cifra 11 (real 3)");
    expect(checkQuality("¡Un par de capturas ya, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 2 (real sin racha)");
    expect(checkQuality("¡Un par de capturas ya, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))).toBeNull();
    // Una palabra entre la cifra y «capturas».
    expect(checkQuality("¡Tres buenas capturas, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 3 (real sin racha)");
    expect(checkQuality("¡Tres buenas capturas, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))).toBeNull();
  });

  // ── Auditoría final de D: tablas A, B y C ──
  const simple = {} as const;
  const replyIn = (trigger: "capture" | "capture_streak" | "bad_streak") => ({ kind: "capture_lament" as const, trigger, replyTo: 0 });
  const hunted = (count: number, consecutive: boolean) => ({ kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count, consecutive } });

  it("D tabla A: «veces» / «vez» solo cuentan con una señal de captura en la misma frase", () => {
    // Sin señal: no hablan de capturas (antes se rechazaban).
    for (const text of [
      "Piénsalo dos veces, Chispa.",
      "Te lo he dicho dos veces, Chispa: cuidado.",
      "Por segunda vez te lo digo, Chispa.",
      "Más de dos veces lo he visto, Chispa.",
    ]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue", simple)), text).toBeNull();
    }
    // Con señal: son cifras de capturas de la pareja (Chispa → Brava) y, sin ese dato, no están respaldadas.
    const pairTexts = ["Me has pillado dos veces, Chispa.", "Me has mandado a casa dos veces, Chispa.", "Por segunda vez me pillas, Chispa."];
    for (const text of pairTexts) {
      expect(checkQuality(text, say("ai-pink", "ai-blue", replyIn("capture"))), text).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (sin datos, del rival a quien habla)" });
    }
    // Una mala racha de 2 (de cualquiera) ya NO las respalda (auditoría de P4): la pareja es 1.
    const badMixed = factsOf([cap(10, "ai-green", "ai-pink"), cap(20, "ai-blue", "ai-pink")], "ai-pink");
    for (const text of pairTexts) {
      expect(checkQuality(text, say("ai-pink", "ai-blue", { ...hunted(2, true), captures: badMixed })), text).toEqual({
        reason: "afirmación no respaldada",
        term: "cifra 2 (real 1, del rival a quien habla)",
      });
    }
    // Con el recuento real de la pareja (Chispa ha capturado dos veces a Brava), se aceptan.
    const badPair = factsOf([cap(10, "ai-blue", "ai-pink"), cap(20, "ai-blue", "ai-pink")], "ai-pink");
    for (const text of pairTexts) expect(checkQuality(text, say("ai-pink", "ai-blue", { ...hunted(2, true), captures: badPair })), text).toBeNull();
  });

  it("D: la señal de captura es léxica y por frase (sin coincidencias accidentales)", () => {
    // La señal tiene que estar en la MISMA frase.
    expect(checkQuality("Me has pillado, sí. Piénsalo dos veces, Chispa.", say("ai-pink", "ai-blue", { kind: "capture_lament" }))).toBeNull();
    // Palabras que contienen las señales pero no lo son: «capturista», «pillería», «cazuela», «racheado», «acasa».
    for (const text of ["Dos veces lo dijo el capturista, Chispa.", "Dos veces vi esa pillería, Chispa.", "Dos veces probé la cazuela, Chispa.", "Dos veces racheado, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    // Señales válidas: «capturado», «cazado», «comido», «en poco tiempo», «racha», «seguidas».
    for (const text of ["Dos veces me has capturado, Chispa.", "Dos veces me has cazado, Chispa.", "Dos veces me has comido, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue"))?.term, text).toBe("cifra 2 (sin datos, del rival a quien habla)");
    }
    for (const text of ["Dos veces en poco tiempo, Chispa.", "Dos veces, qué racha, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue"))?.term, text).toBe("cifra 2 (real sin racha)");
    }
  });

  it("D cambio 2: «capturas» como verbo no es una cifra; como sustantivo, sí", () => {
    // Verbo: tras una palabra de tiempo o turno, o con complemento.
    for (const text of ["Si en dos turnos capturas otra, me retiro, Chispa.", "En tres tiradas capturas una, seguro, Chispa.", "Si en dos jugadas capturas mi ficha, me enfado, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    // Sustantivo: con palabra intercalada o sin ella.
    expect(checkQuality("¡Tres buenas capturas, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 3 (real sin racha)");
    expect(checkQuality("¡Dos capturas limpias, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 2 (real sin racha)");
    expect(checkQuality("¡Tres buenas capturas, Chispa!", say("ai-pink", "ai-blue", streakOf(3)))).toBeNull();
  });

  it("D cambio 3 (tabla B): «consecutivas/os» igual que «seguidas/os»", () => {
    expect(checkQuality("Dos consecutivas, Chispa.", say("ai-pink", "ai-blue"))).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
    expect(checkQuality("Tres capturas consecutivas, Chispa.", say("ai-pink", "ai-blue", streakOf(3, false)))).toEqual({
      reason: "afirmación no respaldada",
      term: "consecutivas (real en poco tiempo)",
    });
    expect(checkQuality("Tres capturas consecutivas, Chispa.", say("ai-pink", "ai-blue", streakOf(3, true)))).toBeNull();
    // Sin cifra: solo con una racha consecutiva respaldada.
    expect(checkQuality("¡Capturas consecutivas, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))).toBeNull();
    expect(checkQuality("¡Capturas consecutivas, Chispa!", say("ai-pink", "ai-blue", streakOf(2, false)))?.term).toBe("consecutivas (real en poco tiempo)");
    expect(checkQuality("¡Capturas consecutivas, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("consecutivas (sin racha)");
    // Réplica dentro de una racha (sin datos de racha): «seguidas» no está respaldada.
    expect(checkQuality("¡Van seguidas, Brava!", say("ai-blue", "ai-pink", replyIn("capture_streak")))?.term).toBe("seguidas (sin racha)");
  });

  it("D cambio 4: «doble captura» y ordinales en cifra con sufijo", () => {
    expect(checkQuality("¡Doble captura, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 2 (real sin racha)");
    expect(checkQuality("¡Doble captura, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))).toBeNull();
    expect(checkQuality("¡Triple captura, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))?.term).toBe("cifra 3 (real 2)");
    for (const text of ["¡2ª captura, Chispa!", "¡2º captura, Chispa!", "¡2a captura, Chispa!"]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
      expect(checkQuality(text, say("ai-pink", "ai-blue", hunted(2, true))), text).toBeNull();
    }
    // «Por 2ª vez me pillas» es de la pareja: la mala racha no basta; el recuento de la pareja, sí.
    const pairText = "Por 2ª vez me pillas, Chispa.";
    expect(checkQuality(pairText, say("ai-pink", "ai-blue"))?.term).toBe("cifra 2 (sin datos, del rival a quien habla)");
    expect(checkQuality(pairText, say("ai-pink", "ai-blue", hunted(2, true)))?.term).toBe("cifra 2 (sin datos, del rival a quien habla)");
    const twice = factsOf([cap(10, "ai-blue", "ai-pink"), cap(20, "ai-blue", "ai-pink")], "ai-pink");
    expect(checkQuality(pairText, say("ai-pink", "ai-blue", { ...hunted(2, true), captures: twice }))).toBeNull();
    expect(checkQuality("¡3er captura, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))?.term).toBe("cifra 3 (real 2)");
    // Cifras que no son ordinales: «2 a casa», «de 1 a 3 casillas», «3 o 4 casillas», «la casilla 2».
    for (const text of ["Con un 5 salgo y 2 a casa, Chispa.", "De 1 a 3 casillas me separan, Chispa.", "Me faltan 3 o 4 casillas, Chispa.", "La casilla 2 es mía, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    // «1ª vez» y «primera vez» no cuentan capturas.
    expect(checkQuality("Es la 1ª vez que gano, señores.", say("ai-blue", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
  });

  it("D tabla C: los casos que ya funcionaban siguen igual", () => {
    expect(checkQuality("Una captura limpia, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
    expect(checkQuality("Una captura limpia, Chispa.", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }))?.term).toBe("cifra 1 (real sin racha)");
    // «Me has pillado dos veces seguidas» es de la pareja: se comprueba con su recuento y su ritmo reales.
    const seguidas = "Me has pillado dos veces seguidas, Chispa.";
    const pair2 = factsOf([cap(10, "ai-blue", "ai-pink"), cap(20, "ai-blue", "ai-pink")], "ai-pink");
    expect(checkQuality(seguidas, say("ai-pink", "ai-blue", { ...hunted(2, true), captures: pair2 }))).toBeNull();
    const pair3 = factsOf([cap(10, "ai-blue", "ai-pink"), cap(15, "ai-green", "ai-purple"), cap(17, "ai-blue", "ai-pink"), cap(20, "ai-blue", "ai-pink")], "ai-pink");
    expect(checkQuality(seguidas, say("ai-pink", "ai-blue", { ...hunted(3, false), captures: pair3 }))?.term).toBe("cifra 2 (real 3, del rival a quien habla)");
    expect(checkQuality(seguidas, say("ai-pink", "ai-blue", hunted(2, true)))?.term).toBe("cifra 2 (sin datos, del rival a quien habla)");
    expect(checkQuality("Tres veces en poco tiempo, cariño.", say("ai-green", "ai-blue", hunted(3, false)))).toBeNull();
    expect(checkQuality("¡Tres seguidas, qué barbaridad!", say("ai-blue", "ai-pink", replyIn("capture_streak")))?.term).toBe("cifra 3 (real sin racha)");
    expect(checkQuality("A veces pasa, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
    expect(checkQuality("Mil veces te lo dije, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
  });

  it("D: no rechaza números que no hablan de capturas", () => {
    for (const text of [
      "Cinco casillas más y estoy a salvo, Chispa.",
      "Con un 5 me vengo, ya verás, Chispa.",
      "Dos fichas en casa y todavía sonrío, Chispa.",
      "Una vez más, a casa esa ficha, Chispa.",
      "Otra vez tú, Chispa. Qué manía.",
    ]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
  });

  // ── Registro de coletillas de la partida (usedCatchphrases), sin depender de la ventana de 12 ──
  it("partida 4e120c1e: Pilar #24 y Don Ernesto #20 se rechazan con el registro aunque el texto anterior esté fuera de la ventana", () => {
    // #24 (victoria de Pilar): «Despacito y buena letra» ya publicada en el #10, cientos de versiones antes.
    const pilar24 = "Ay, hijo, qué partida más larga. Despacito y buena letra, que el que mucho abarca, poco aprieta.";
    expect(reject(pilar24, say("ai-green", null, { kind: "victory_win", trigger: "victory" }, [], [0]))).toEqual({
      reason: "expresión característica repetida",
      detail: "termino=Despacito y buena letra",
    });
    // #20 (réplica de Ernesto): «Previsible» ya publicada en el #6.
    const ernesto20 = "Previsible: su captura confirma la ley de probabilidades que manejo.";
    expect(reject(ernesto20, say("ai-purple", "ai-blue", { kind: "capture_lament", replyTo: 0 }, [], [0]))).toEqual({
      reason: "expresión característica repetida",
      detail: "termino=Previsible",
    });
    // Sin registro (la primera vez), los dos se aceptan.
    expect(reject(pilar24, say("ai-green", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
    expect(reject(ernesto20, say("ai-purple", "ai-blue", { kind: "capture_lament", replyTo: 0 }))).toBeNull();
  });

  it("el registro es por personaje y no rechaza expresiones comunes ni coletillas no usadas", () => {
    // Pilar tiene registrada la 0; «Ay, hijo, qué prisas» (1) sí se puede usar.
    expect(checkQuality("Ay, hijo, qué prisas, Chispa.", say("ai-green", "ai-blue", {}, [], [0]))).toBeNull();
    expect(checkQuality("Ay, hijo, qué prisas, Chispa.", say("ai-green", "ai-blue", {}, [], [1]))?.term).toBe("Ay, hijo, qué prisas");
    // «Vuelve a casa» no es la coletilla de Brava aunque «¡A casa!» esté registrada.
    expect(checkQuality("Vuelve a casa, Chispa.", say("ai-pink", "ai-blue", {}, [], [0]))).toBeNull();
    // Chispa no hereda el registro de Brava: la petición solo lleva el de quien habla.
    expect(checkQuality("¡A casa, Brava!", say("ai-blue", "ai-pink", {}, [], []))).toBeNull();
  });

  // ── P2: longitud en frases, «Don» truncado y Pilar llamando «abuela» a otro ──
  it("P2: como mucho dos frases; puntos suspensivos, abreviaturas y signos no cortan frases de más", () => {
    expect(countSentences("¡A casa, Chispa!")).toBe(1);
    expect(countSentences("¡Toma! A casa, Chispa.")).toBe(2);
    expect(countSentences("Ay… ya veremos al final, cariño.")).toBe(1);
    expect(countSentences("Quien ríe el último… Ya veremos.")).toBe(2);
    expect(countSentences("Sra. Pilar, su ficha vuelve a casa.")).toBe(1);
    expect(countSentences("¿¡Otra vez!? Pues vale.")).toBe(2);
    expect(checkQuality("¡Toma! A casa, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
    expect(checkQuality("¡Toma! A casa, Chispa. ¡Y no vuelvas!", say("ai-pink", "ai-blue"))).toEqual({ reason: "demasiadas frases", term: "frases=3" });
  });

  it("P2: «Don»/«Dón» suelto como nombre se rechaza; «Don Ernesto» y el nombre común «un don», no", () => {
    for (const text of ["¡Dón, te vas a quedar sin fichas!", "Venga, Don, que te toca.", "¡Ya verás, Don!"]) {
      expect(checkQuality(text, say("ai-pink", "ai-purple")), text).toEqual({ reason: "mezcla nombres de personajes", term: "don" });
    }
    for (const text of ["¡A casa, Don Ernesto!", "Chispa, tienes un don para el dado.", "¡Qué don tienes, Chispa!"]) {
      expect(checkQuality(text, say("ai-pink", text.includes("Ernesto") ? "ai-purple" : "ai-blue")), text).toBeNull();
    }
  });

  it("P2: Pilar no llama «abuela» a otro; hablar de sí misma como «la abuela» sigue permitido", () => {
    for (const text of ["Con paciencia se llega, abuela.", "Abuela, qué prisas tienes.", "¡Ay, abuela! Qué jugada."]) {
      expect(checkQuality(text, say("ai-green", "ai-blue")), text).toEqual({ reason: "mezcla nombres de personajes", term: "abuela (vocativo)" });
    }
    for (const text of ["Ay, la abuela no corre tanto, Chispa.", "Esta abuela todavía tiene mucho que decir.", "Mi abuela decía que sin prisa."]) {
      expect(checkQuality(text, say("ai-green", "ai-blue")), text).toBeNull();
    }
    // La regla es solo para Pilar: otro personaje que la llama «¡Abuela!» siendo ella el rival, se acepta.
    expect(reject("¡Abuela! Esa ficha vuelve a casa.", say("ai-blue", "ai-green"))).toBeNull();
  });

  // ── P4: rachas en las réplicas ──
  describe("P4: rachas y cifras con el estado real (hechos del director, también en las réplicas)", () => {
    const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
    const unsupported = (term: string) => ({ reason: "afirmación no respaldada", term });
    const at = (speaker: string, rival: string, log: ReturnType<typeof cap>[], extra: Partial<Utterance>) =>
      say(speaker, rival, { ...extra, captures: factsOf(log, speaker) });

    // Historiales (la última captura es la de esta versión).
    /** Brava: 3 capturas seguidas a tres rivales distintos (solo 1 a Chispa). */
    const HUNT = [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, CHISPA)];
    /** Chispa: capturada por Pilar y después por Brava (2 seguidas, solo 1 de Brava). */
    const BAD = [cap(10, PILAR, CHISPA), cap(20, BRAVA, CHISPA)];
    /** Brava llevaba 3 y Chispa la captura: la racha de Brava se interrumpe. */
    const CUT = [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, PILAR), cap(40, CHISPA, BRAVA)];
    /** A Chispa la capturaron dos veces seguidas y ahora captura ella: su mala racha se interrumpe. */
    const TURN = [cap(10, BRAVA, CHISPA), cap(20, PILAR, CHISPA), cap(30, CHISPA, ERNESTO)];
    /** Brava ha capturado a Chispa dos veces seguidas (pareja real). */
    const PAIR = [cap(10, BRAVA, CHISPA), cap(20, BRAVA, CHISPA)];
    /** Una captura suelta: ninguna racha. */
    const LONE = [cap(10, BRAVA, CHISPA)];

    // Réplicas de cada disparador (el mensaje principal lo dijo el otro).
    const huntReply = { kind: "capture_lament" as const, trigger: "capture_streak" as const, replyTo: 0 };
    const badReply = { kind: "capture_boast" as const, trigger: "bad_streak" as const, replyTo: 0 };

    it("auditoría: Chispa (réplica en capture_streak) «me has capturado tres veces» con 3 globales de Brava, pero 1 contra Chispa", () => {
      expect(checkQuality("Brava, me has capturado tres veces.", at(CHISPA, BRAVA, HUNT, huntReply))).toEqual(unsupported("cifra 3 (real 1, del rival a quien habla)"));
      // El recuento global sí es correcto atribuido a Brava, en la réplica.
      expect(checkQuality("Brava, llevas tres capturas seguidas.", at(CHISPA, BRAVA, HUNT, huntReply))).toBeNull();
      expect(checkQuality("Tres capturas ya, Brava. Me la apunto.", at(CHISPA, BRAVA, HUNT, huntReply))).toBeNull();
    });

    it("auditoría: Brava (réplica en bad_streak) «te he capturado dos veces seguidas» sin dos capturas seguidas suyas a Chispa", () => {
      expect(checkQuality("Te he capturado dos veces seguidas, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toEqual(unsupported("cifra 2 (real 1, de quien habla al rival)"));
      // Lo que sí es verdad: a Chispa le han capturado dos veces seguidas.
      expect(checkQuality("Te han capturado dos veces seguidas, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toBeNull();
    });

    it("1. racha de capturas que continúa: cifra y ritmo reales; decir que termina se rechaza", () => {
      const main = { kind: "streak_boast" as const, trigger: "capture_streak" as const, streak: { count: 3, consecutive: true } };
      expect(checkQuality("¡Tres capturas seguidas, Chispa!", at(BRAVA, CHISPA, HUNT, main))).toBeNull();
      expect(checkQuality("¡Mi racha sigue, Chispa!", at(BRAVA, CHISPA, HUNT, main))).toBeNull();
      expect(checkQuality("¡Cuatro capturas, Chispa!", at(BRAVA, CHISPA, HUNT, main))).toEqual(unsupported("cifra 4 (real 3)"));
      expect(checkQuality("Se acabó mi racha, Chispa.", at(BRAVA, CHISPA, HUNT, main))).toEqual(unsupported("fin de racha"));
    });

    it("2. mala racha que continúa: la víctima y su rival la cuentan con datos reales; decir que termina se rechaza", () => {
      const main = { kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count: 2, consecutive: true } };
      expect(checkQuality("Me han capturado dos veces seguidas, Brava.", at(CHISPA, BRAVA, BAD, main))).toBeNull();
      expect(checkQuality("Mi mala racha sigue, Brava.", at(CHISPA, BRAVA, BAD, main))).toBeNull();
      expect(checkQuality("Me han capturado tres veces, Brava.", at(CHISPA, BRAVA, BAD, main))).toEqual(unsupported("cifra 3 (real 2, recibidas por quien habla)"));
      expect(checkQuality("Tu mala racha se acaba aquí, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toEqual(unsupported("fin de racha"));
    });

    it("3. racha de capturas interrumpida de verdad: se puede decir, desde los dos lados; que sigue, no", () => {
      expect(checkQuality("Se acabó tu racha, Brava.", at(CHISPA, BRAVA, CUT, {}))).toBeNull();
      expect(checkQuality("¡Fin de tu racha, Brava!", at(CHISPA, BRAVA, CUT, {}))).toBeNull();
      expect(checkQuality("Tu racha de tres capturas se ha terminado, Brava.", at(CHISPA, BRAVA, CUT, {}))).toBeNull();
      expect(checkQuality("Tu racha de cuatro capturas se ha terminado, Brava.", at(CHISPA, BRAVA, CUT, {}))).toEqual(unsupported("cifra 4 (real 3, racha del rival)"));
      expect(checkQuality("Se me ha acabado la racha, Chispa.", at(BRAVA, CHISPA, CUT, { kind: "capture_lament", replyTo: 0 }))).toBeNull();
      expect(checkQuality("Tu racha sigue, Brava.", at(CHISPA, BRAVA, CUT, {}))).toEqual(unsupported("racha que sigue"));
    });

    it("4. mala racha interrumpida de verdad: se puede decir; la mala racha de otro, no", () => {
      expect(checkQuality("¡Se acabó mi mala racha, Don Ernesto!", at(CHISPA, ERNESTO, TURN, {}))).toBeNull();
      expect(checkQuality("Su mala racha ha terminado, Chispa.", at(ERNESTO, CHISPA, TURN, { kind: "capture_lament", replyTo: 0 }))).toBeNull();
      // Quien recibe no tenía mala racha: afirmar que se le acabó no está respaldado.
      expect(checkQuality("Se acabó mi mala racha, Chispa.", at(ERNESTO, CHISPA, TURN, { kind: "capture_lament", replyTo: 0 }))).toEqual(unsupported("fin de racha"));
    });

    it("5 y 12. sin racha ni datos: ni rachas ni cifras", () => {
      expect(checkQuality("Se acabó tu racha, Chispa.", at(BRAVA, CHISPA, LONE, {}))).toEqual(unsupported("fin de racha"));
      expect(checkQuality("Vaya racha llevo, Chispa.", at(BRAVA, CHISPA, LONE, {}))).toEqual(unsupported("racha"));
      expect(checkQuality("Te he capturado dos veces, Chispa.", at(BRAVA, CHISPA, LONE, {}))).toEqual(unsupported("cifra 2 (real 1, de quien habla al rival)"));
      expect(checkQuality("¡Tres capturas, Chispa!", at(BRAVA, CHISPA, LONE, {}))).toEqual(unsupported("cifra 3 (real sin racha)"));
      expect(checkQuality("¡Dos seguidas, Chispa!", at(BRAVA, CHISPA, LONE, {}))).toEqual(unsupported("cifra 2 (real sin racha)"));
      // Sin hechos de captura (victoria): nada verificable.
      expect(checkQuality("Te he capturado tres veces, Chispa.", say(BRAVA, CHISPA, { kind: "victory_reply", trigger: "victory", replyTo: 0 }))).toEqual(
        unsupported("cifra 3 (sin datos, de quien habla al rival)"),
      );
      // «una captura» sigue siendo la de este momento.
      expect(checkQuality("Una captura limpia, Chispa.", at(BRAVA, CHISPA, LONE, {}))).toBeNull();
    });

    it("6 y 7. réplicas que afirman que una racha terminó: falso si sigue, correcto si se interrumpió", () => {
      for (const text of ["Tu racha se acaba, Brava.", "Se te acabó la racha, Brava.", "Tu racha ha llegado a su fin, Brava.", "Adiós a tu racha, Brava.", "Sí, se acabó tu racha, Brava."]) {
        expect(checkQuality(text, at(CHISPA, BRAVA, HUNT, huntReply)), text).toEqual(unsupported("fin de racha"));
      }
      for (const text of ["Se te acabó la racha, Brava.", "Tu racha ha llegado a su fin, Brava.", "Adiós a tu racha, Brava."]) {
        expect(checkQuality(text, at(CHISPA, BRAVA, CUT, { kind: "capture_boast", replyTo: 0 })), text).toBeNull();
      }
      // #17 (84d066b1) con datos reales: la mala racha de Chispa sigue.
      expect(checkQuality("Su mala racha se acaba. Su ficha vuelve a casa.", at(ERNESTO, CHISPA, [cap(10, PILAR, CHISPA), cap(20, ERNESTO, CHISPA)], badReply))).toEqual(unsupported("fin de racha"));
    });

    it("preguntas, deseos e hipótesis no afirman nada; las negaciones son continuidad", () => {
      for (const text of [
        "¿Se acabó tu racha, Brava?",
        "A ver si se acaba tu racha, Brava.",
        "Ojalá se acaba pronto tu racha, Brava.",
        "Que se te acabe la racha, Brava.",
        "Si se rompe tu racha, me alegro, Brava.",
        "Tu racha se acabará, Brava.",
      ]) {
        expect(checkQuality(text, at(CHISPA, BRAVA, HUNT, huntReply)), text).toBeNull();
      }
      expect(checkQuality("Tu racha no se acaba nunca, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toBeNull();
      expect(checkQuality("No se acabó tu racha, Brava.", at(CHISPA, BRAVA, CUT, {}))).toEqual(unsupported("racha que sigue"));
    });

    it("8, 9 y 10. recuento global frente a recuento de la pareja, en cada dirección", () => {
      // 8. Global correcto, atribución incorrecta: Brava lleva 3, pero solo 1 contra Chispa.
      expect(checkQuality("Ya me has pillado tres veces, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toEqual(unsupported("cifra 3 (real 1, del rival a quien habla)"));
      expect(checkQuality("Te he capturado tres veces, Chispa.", at(BRAVA, CHISPA, HUNT, { kind: "streak_boast", trigger: "capture_streak", streak: { count: 3, consecutive: true } }))).toEqual(
        unsupported("cifra 3 (real 1, de quien habla al rival)"),
      );
      // 9. Pareja correcta, desde los dos lados.
      expect(checkQuality("Me has capturado dos veces seguidas, Brava.", at(CHISPA, BRAVA, PAIR, huntReply))).toBeNull();
      expect(checkQuality("Te he capturado dos veces seguidas, Chispa.", at(BRAVA, CHISPA, PAIR, { kind: "streak_boast", trigger: "capture_streak", streak: { count: 2, consecutive: true } }))).toBeNull();
      expect(checkQuality("Es la segunda vez que me pillas, Brava.", at(CHISPA, BRAVA, PAIR, huntReply))).toBeNull();
      // 10. Pareja incorrecta (cifra o ritmo) y dirección cambiada.
      expect(checkQuality("Me has capturado tres veces, Brava.", at(CHISPA, BRAVA, PAIR, huntReply))).toEqual(unsupported("cifra 3 (real 2, del rival a quien habla)"));
      const mixed = [cap(10, BRAVA, CHISPA), cap(15, PILAR, ERNESTO), cap(20, BRAVA, CHISPA)];
      expect(checkQuality("Me has capturado dos veces seguidas, Brava.", at(CHISPA, BRAVA, mixed, { kind: "capture_lament", replyTo: 0 }))).toEqual(
        unsupported("seguidas (no seguidas, del rival a quien habla)"),
      );
      expect(checkQuality("Te he capturado dos veces, Brava.", at(CHISPA, BRAVA, PAIR, huntReply))).toEqual(unsupported("cifra 2 (real 0, de quien habla al rival)"));
      // Con dos cifras en la frase, cada una con su sujeto (la señal más cercana).
      expect(checkQuality("Llevas tres capturas y a mí me has pillado una vez, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toBeNull();
      expect(checkQuality("Llevas tres capturas y me has pillado dos veces, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toEqual(unsupported("cifra 2 (real 1, del rival a quien habla)"));
    });

    it("11. réplicas de capture_streak y bad_streak: cada una con su propio punto de vista", () => {
      // capture_streak: responde la víctima (Chispa). Puede contar la racha de Brava, no la suya.
      expect(checkQuality("Tu racha sigue, Brava, pero ya te pillaré.", at(CHISPA, BRAVA, HUNT, huntReply))).toBeNull();
      expect(checkQuality("Mi racha sigue, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toEqual(unsupported("racha que sigue"));
      expect(checkQuality("Mi mala racha empieza hoy, Brava.", at(CHISPA, BRAVA, HUNT, huntReply))).toEqual(unsupported("racha"));
      // bad_streak: responde quien captura (Brava). Puede contar la mala racha de Chispa, no una suya.
      expect(checkQuality("Tu mala racha sigue, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toBeNull();
      expect(checkQuality("A ti te han capturado dos veces, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toBeNull();
      expect(checkQuality("Llevo dos capturas, Chispa.", at(BRAVA, CHISPA, BAD, badReply))).toEqual(unsupported("cifra 2 (real 1, hechas por quien habla)"));
      // Sin sujeto, la cifra es la de la racha que provocó la intervención (la mala racha de Chispa).
      expect(checkQuality("¡Dos seguidas, Chispa!", at(BRAVA, CHISPA, BAD, badReply))).toBeNull();
    });
  });

  describe("P4, auditoría final: hipótesis por cláusula, «una vez», reinicios, fichas y cifras sin sustantivo", () => {
    const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
    const unsupported = (term: string) => ({ reason: "afirmación no respaldada", term });
    const at = (speaker: string, rival: string, log: ReturnType<typeof cap>[], extra: Partial<Utterance>) =>
      say(speaker, rival, { ...extra, captures: factsOf(log, speaker) });
    /** Racha ACTIVA de Brava (3 seguidas); responde Chispa, la víctima. */
    const active = () => at(CHISPA, BRAVA, [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, CHISPA)], { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 });
    /** Racha de Brava INTERRUMPIDA: Chispa acaba de capturarla. */
    const ended = () => at(CHISPA, BRAVA, [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, PILAR), cap(40, CHISPA, BRAVA)], {});

    it("afirmaciones con otra cláusula hipotética delante o detrás: se validan (falsas con la racha activa)", () => {
      for (const text of [
        "Si quieres, se acabó tu racha, Brava.",
        "Quizá mañana gane, pero se acabó tu racha, Brava.",
        "Si me preguntas, tu racha ya se acabó, Brava.",
        "Si, se acabó tu racha, Brava.",
        "Sí, se acabó tu racha, Brava.",
        "Se acabó tu racha, ¿verdad, Brava?",
        "Se te acaba la racha, Brava.",
      ]) {
        expect(checkQuality(text, active()), text).toEqual(unsupported("fin de racha"));
        expect(checkQuality(text, ended()), text).toBeNull();
      }
    });

    it("hipótesis, deseos y preguntas en la MISMA cláusula: no son hechos (ni con la racha activa ni interrumpida)", () => {
      for (const text of [
        "Si se acaba tu racha, lo celebraré, Brava.",
        "Tu racha se acaba si te pillo, Brava.",
        "Ojalá se acabe tu racha, Brava.",
        "A ver si se acaba tu racha, Brava.",
        "Puede que se haya terminado tu racha, Brava.",
        "¿Se te ha acabado la racha, Brava?",
        "Brava, ¿se acabó tu racha?",
      ]) {
        expect(checkQuality(text, active()), text).toBeNull();
        expect(checkQuality(text, ended()), text).toBeNull();
      }
    });

    it("negación: «tu racha no se ha terminado» afirma que sigue", () => {
      expect(checkQuality("Tu racha no se ha terminado, Brava.", active())).toBeNull();
      expect(checkQuality("Tu racha no se ha terminado, Brava.", ended())).toEqual(unsupported("racha que sigue"));
      expect(checkQuality("No se te acaba la racha, Brava.", ended())).toEqual(unsupported("racha que sigue"));
    });

    it("«una vez» y «la primera vez» son recuentos: pareja con 0, 1 y 3 capturas, en las dos direcciones", () => {
      const zero = [cap(10, CHISPA, BRAVA)]; // Brava nunca ha capturado a Chispa
      const one = [cap(10, BRAVA, CHISPA)];
      const three = [cap(10, BRAVA, CHISPA), cap(20, BRAVA, CHISPA), cap(30, BRAVA, CHISPA)];
      for (const text of ["Me has capturado una vez, Brava.", "Es la primera vez que me pillas, Brava."]) {
        expect(checkQuality(text, at(CHISPA, BRAVA, zero, {})), text).toEqual(unsupported("cifra 1 (real 0, del rival a quien habla)"));
        expect(checkQuality(text, at(CHISPA, BRAVA, one, { kind: "capture_lament" })), text).toBeNull();
        expect(checkQuality(text, at(CHISPA, BRAVA, three, { kind: "capture_lament", trigger: "capture_streak" })), text).toEqual(unsupported("cifra 1 (real 3, del rival a quien habla)"));
      }
      // Dirección contraria: de quien habla al rival.
      expect(checkQuality("Te he capturado una vez, Chispa.", at(BRAVA, CHISPA, one, {}))).toBeNull();
      expect(checkQuality("Te he capturado una vez, Chispa.", at(BRAVA, CHISPA, three, { kind: "streak_boast", trigger: "capture_streak" }))).toEqual(unsupported("cifra 1 (real 3, de quien habla al rival)"));
      expect(checkQuality("Te he capturado una vez, Brava.", at(CHISPA, BRAVA, three, { kind: "capture_lament", trigger: "capture_streak" }))).toEqual(unsupported("cifra 1 (real 0, de quien habla al rival)"));
      // Sin datos (victoria): no es un hecho.
      expect(checkQuality("Te he capturado una vez, Chispa.", say(BRAVA, CHISPA, { kind: "victory_reply", trigger: "victory", replyTo: 0 }))).toEqual(unsupported("cifra 1 (sin datos, de quien habla al rival)"));
    });

    it("expresiones hechas con «vez» y la captura de ahora («una captura», «una ficha») no son recuentos", () => {
      const three = [cap(10, BRAVA, CHISPA), cap(20, BRAVA, CHISPA), cap(30, BRAVA, CHISPA)];
      const req = at(CHISPA, BRAVA, three, { kind: "capture_lament", trigger: "capture_streak" });
      for (const text of [
        "Una vez más me has pillado, Brava.",
        "Me pillas de una vez, Brava.",
        "Por una vez me has pillado, Brava.",
        "Una vez que me pillas, no paras, Brava.",
        "Otra vez me has pillado, Brava.",
        "¿Alguna vez me has pillado tú, Brava?",
        "Me has comido una ficha, Brava.",
        "Una captura más, Brava.",
      ]) {
        expect(checkQuality(text, req), text).toBeNull();
      }
      // «una ficha» con el papel cambiado no es la captura de ahora: Chispa no ha capturado a Brava.
      expect(checkQuality("Te he comido una ficha, Brava.", req)).toEqual(unsupported("cifra 1 (real 0, de quien habla al rival)"));
    });

    it("fichas regidas por un verbo de captura son cifras; las demás fichas, no", () => {
      const one = at(CHISPA, BRAVA, [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, CHISPA)], { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 });
      expect(checkQuality("Me has comido tres fichas, Brava.", one)).toEqual(unsupported("cifra 3 (real 1, del rival a quien habla)"));
      expect(checkQuality("Me has mandado tres fichas a casa, Brava.", one)).toEqual(unsupported("cifra 3 (real 1, del rival a quien habla)"));
      expect(checkQuality("Me has mandado dos de mis fichas a casa, Brava.", one)).toEqual(unsupported("cifra 2 (real 1, del rival a quien habla)"));
      const three = at(CHISPA, BRAVA, [cap(10, BRAVA, CHISPA), cap(20, BRAVA, CHISPA), cap(30, BRAVA, CHISPA)], { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 });
      expect(checkQuality("Me has comido tres fichas, Brava.", three)).toBeNull();
      for (const text of ["Me quedan dos fichas en casa, Brava.", "Llevo dos fichas en el pasillo, Brava.", "Tengo tres fichas fuera, Brava."]) {
        expect(checkQuality(text, one), text).toBeNull();
      }
    });

    it("números en palabra a partir de dieciséis", () => {
      const req = active();
      expect(checkQuality("Dieciséis capturas, Brava.", req)).toEqual(unsupported("cifra 16 (real 3)"));
      expect(checkQuality("Me has capturado veintidós veces, Brava.", req)).toEqual(unsupported("cifra 22 (real 1, del rival a quien habla)"));
      expect(checkQuality("Llevas treinta capturas, Brava.", req)).toEqual(unsupported("cifra 30 (real 3, hechas por el rival)"));
    });

    it("cifras sin sustantivo: se validan si el contexto dice qué se cuenta; si no, no son un hecho", () => {
      expect(checkQuality("Ya van tres, Brava.", active())).toBeNull();
      expect(checkQuality("Ya van cuatro, Brava.", active())).toEqual(unsupported("cifra 4 (real 3)"));
      expect(checkQuality("Llevas tres, Brava.", active())).toBeNull();
      expect(checkQuality("Llevas cinco y no paras, Brava.", active())).toEqual(unsupported("cifra 5 (real 3, hechas por el rival)"));
      expect(checkQuality("Ya van dos, Chispa.", say(BRAVA, CHISPA, { kind: "victory_reply", trigger: "victory", replyTo: 0 }))).toEqual(unsupported("cifra 2 (real sin racha)"));
      // Números incidentales: con sustantivo detrás, otras cosas u otras horas, no son cifras de capturas.
      for (const text of ["Llevo dos fichas en el pasillo, Brava.", "Van dos fichas en casa, Brava.", "Ya son las tres, Brava.", "Con un 5 salgo, Brava."]) {
        expect(checkQuality(text, active()), text).toBeNull();
      }
    });

    it("R1 y R2: varias capturas en poco tiempo sin racha viva tras una interrupción", () => {
      // R1: Brava v10, v20, v30; Chispa la corta en v40; Brava captura a Pilar en v50. Responde Pilar.
      const r1 = [cap(10, BRAVA, PILAR), cap(20, BRAVA, ERNESTO), cap(30, BRAVA, PILAR), cap(40, CHISPA, BRAVA), cap(50, BRAVA, PILAR)];
      const pilar = at(PILAR, BRAVA, r1, { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 });
      expect(checkQuality("Tu racha sigue, Brava.", pilar)).toEqual(unsupported("racha que sigue"));
      expect(checkQuality("Tu racha de cuatro capturas, Brava.", pilar)).toEqual(unsupported("cifra 4 (sin datos, racha del rival)"));
      expect(checkQuality("Ya van cuatro, Brava.", pilar)).toEqual(unsupported("cifra 4 (real sin racha)"));
      expect(checkQuality("Llevas cuatro capturas en poco tiempo, Brava.", pilar)).toBeNull();
      expect(checkQuality("Desde entonces solo llevas una, Brava.", pilar)).toBeNull();
      expect(checkQuality("Desde entonces llevas dos, Brava.", pilar)).toEqual(unsupported("cifra 2 (real 1, hechas por el rival desde que le capturaron)"));
      // Brava (mensaje principal): sus cuatro capturas son un hecho; su racha activa, no.
      const brava = at(BRAVA, PILAR, r1, { kind: "streak_boast", trigger: "capture_streak", streak: { count: 4, consecutive: false } });
      expect(checkQuality("¡Cuatro capturas en poco tiempo, Abuela Pilar!", brava)).toBeNull();
      expect(checkQuality("¡Mi racha sigue, Abuela Pilar!", brava)).toEqual(unsupported("racha que sigue"));
      // R2: a Chispa la capturan en v10, v20, v30; captura ella en v40; la vuelven a capturar en v50.
      const r2 = [cap(10, BRAVA, CHISPA), cap(20, PILAR, CHISPA), cap(30, ERNESTO, CHISPA), cap(40, CHISPA, ERNESTO), cap(50, BRAVA, CHISPA)];
      const reply = at(BRAVA, CHISPA, r2, { kind: "capture_boast", trigger: "bad_streak", replyTo: 0 });
      expect(checkQuality("Tu mala racha sigue, Chispa.", reply)).toEqual(unsupported("racha que sigue"));
      expect(checkQuality("Te han capturado cuatro veces en poco tiempo, Chispa.", reply)).toBeNull();
      expect(checkQuality("Desde entonces te han capturado una vez, Chispa.", reply)).toBeNull();
      const chispa = at(CHISPA, BRAVA, r2, { kind: "streak_lament", trigger: "bad_streak", streak: { count: 4, consecutive: false } });
      expect(checkQuality("Mi mala racha sigue, Brava.", chispa)).toEqual(unsupported("racha que sigue"));
      expect(checkQuality("Me han capturado cuatro veces en poco tiempo, Brava.", chispa)).toBeNull();
    });

    it("«seguidas» con historial completo y con un hueco no observado (historial incompleto)", () => {
      const complete = at(BRAVA, CHISPA, [cap(10, BRAVA, CHISPA), cap(15, PILAR, ERNESTO), cap(20, BRAVA, CHISPA)], {});
      expect(checkQuality("Te he capturado dos veces seguidas, Chispa.", complete)).toEqual(unsupported("seguidas (no seguidas, de quien habla al rival)"));
      expect(checkQuality("Te he capturado dos veces, Chispa.", complete)).toBeNull();
      // Si la versión 15 no llegó al chat, el director lo detecta (continuidad) y los hechos son incompletos:
      // ni «seguidas» ni la cifra se pueden afirmar.
      const gap = say(BRAVA, CHISPA, { captures: { history: "incomplete", selfRole: "by" } });
      expect(checkQuality("Te he capturado dos veces seguidas, Chispa.", gap)).toEqual(unsupported("cifra 2 (historial incompleto)"));
      expect(checkQuality("¡Seguidas, Chispa!", gap)).toEqual(unsupported("seguidas (historial incompleto)"));
    });

    describe("historial incompleto: solo la captura de esta versión es un hecho", () => {
      const byReq = (extra: Partial<Utterance> = {}) => say(BRAVA, CHISPA, { ...extra, captures: { history: "incomplete", selfRole: "by" } });
      const victimReq = (extra: Partial<Utterance> = {}) => say(CHISPA, BRAVA, { kind: "capture_lament", ...extra, captures: { history: "incomplete", selfRole: "victim" } });

      it("rechaza cifras (también «una vez», ordinales, fichas y cifras sin sustantivo) y «seguidas»", () => {
        for (const [text, n] of [
          ["¡Tres capturas, Chispa!", 3],
          ["Te he capturado dos veces, Chispa.", 2],
          ["Te he capturado una vez, Chispa.", 1],
          ["¡Mi tercera captura, Chispa!", 3],
          ["Te he comido dos fichas, Chispa.", 2],
          ["¡Ya van tres, Chispa!", 3],
        ] as const) {
          expect(checkQuality(text, byReq({ trigger: "capture_streak", kind: "streak_boast" })), text).toEqual(unsupported(`cifra ${n} (historial incompleto)`));
        }
        // «una vez más» junto a la captura afirma que ya había pasado antes: sin historial, no es verificable.
        expect(checkQuality("Me has pillado una vez más, Brava.", victimReq())).toEqual(unsupported("captura repetida"));
        expect(checkQuality("¡Capturas seguidas, Chispa!", byReq())).toEqual(unsupported("seguidas (historial incompleto)"));
      });

      it("ignora el `streak` del mensaje principal aunque llegue (no es verificable)", () => {
        const req = byReq({ kind: "streak_boast", trigger: "capture_streak", streak: { count: 3, consecutive: true } });
        expect(checkQuality("¡Tres capturas seguidas, Chispa!", req)).toEqual(unsupported("cifra 3 (historial incompleto)"));
      });

      it("rechaza cualquier mención de racha: continuidad, fin, mención, deseo o pregunta", () => {
        for (const text of ["Mi racha sigue, Chispa.", "Se acabó tu racha, Brava.", "¡Vaya racha, Chispa!", "Ojalá se acabe tu racha, Brava.", "¿Se te ha acabado la racha, Brava?"]) {
          const req = text.endsWith("Brava.") || text.endsWith("Brava?") ? victimReq({ trigger: "capture_streak" }) : byReq({ trigger: "capture_streak" });
          expect(checkQuality(text, req), text).toEqual(unsupported("racha (historial incompleto)"));
        }
      });

      it("acepta la captura de esta versión con el papel correcto, y lo que no son cifras", () => {
        for (const text of ["¡Una captura más, Chispa!", "Te he comido una ficha, Chispa.", "¡Otra más! Lo siento, Chispa.", "Otra vez a casa, Chispa."]) {
          expect(checkQuality(text, byReq({ trigger: "capture_streak", kind: "streak_boast" })), text).toBeNull();
        }
        expect(checkQuality("Me has comido una ficha, Brava.", victimReq())).toBeNull();
        // Papel cambiado: quien recibe la captura no la ha hecho.
        expect(checkQuality("Te he comido una ficha, Brava.", victimReq())).toEqual(unsupported("cifra 1 (historial incompleto)"));
        // En la victoria no hay captura de ahora.
        expect(checkQuality("¡Una captura limpia, Chispa!", say(BRAVA, CHISPA, { kind: "victory_reply", trigger: "victory", replyTo: 0 }))?.term).toBe("cifra 1 (real sin racha)");
      });
    });
  });

  it("regresión de la partida 84d066b1: se rechazan #16, #26, #7 y #17; se aceptan #4, #10, #21 y #28", () => {
    const badStreak = { kind: "streak_lament" as const, trigger: "bad_streak" as const, streak: { count: 2, consecutive: false } };
    // #16 Chispa (tres frases).
    expect(reject("¡Ojo con la racha, Don Ernesto! Tu captura fue pura picardía, pero la próxima vez la cobro con intereses. ¡El dado no perdona!", say("ai-blue", "ai-purple", badStreak))?.reason).toBe("demasiadas frases");
    // #26 Brava («Dón»).
    expect(reject("¡Dón, te vas a quedar sin fichas para la salida!", say("ai-pink", "ai-purple", badStreak))?.reason).toBe("mezcla nombres de personajes");
    // #7 Pilar (llama «abuela» a otro).
    expect(reject("Con paciencia, el buen camino se alcanza, abuela.", say("ai-green", "ai-blue"))?.reason).toBe("mezcla nombres de personajes");
    // #17 Don Ernesto (réplica: «su racha se acaba», cuando la mala racha de Chispa sigue).
    const reply = { kind: "capture_boast" as const, trigger: "bad_streak" as const, replyTo: 0, streak: { count: 2, consecutive: false } };
    expect(reject("Su racha se acaba. Su ficha vuelve a casa, y usted no recupera la pérdida.", say("ai-purple", "ai-blue", reply))).toEqual({
      reason: "afirmación no respaldada",
      detail: "termino=fin de racha",
    });
    // Mensajes de esa partida que están bien.
    expect(reject("¡Vuelve al principio, hijo, que la prudencia vale más que la prisa!", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("¡Chispa, me la pagas ahora!", say("ai-pink", "ai-blue", { kind: "capture_lament", replyTo: 0 }))).toBeNull();
    expect(reject("¡Vuelve a empezar, Pilar!", say("ai-pink", "ai-green"))).toBeNull();
    expect(reject("Cariño, con paciencia se gana el premio.", say("ai-green", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
  });

  it("los motivos nuevos están en la lista cerrada que se registra", () => {
    expect(QUALITY_REASONS).toContain("demasiadas frases");
    for (const reason of QUALITY_REASONS) expect(INVALID_RESPONSE_REASONS).toContain(reason);
  });
});

describe("género del destinatario (apelativos en vocativo)", () => {
  const GENDER = "no concuerda el género del destinatario";

  it("regresión: Pilar llamaba «hijito» a Brava y «hijita» a Chispa (flujo completo de cleanLlmText)", () => {
    expect(reject("Pues eso es lo que tiene jugar con las que más quieres, hijito", say("ai-green", "ai-pink"))).toEqual({
      reason: GENDER,
      detail: "termino=hijito (Brava: femenino)",
    });
    expect(reject("La vida son juegos, hijita, y las fichas se van.", say("ai-green", "ai-blue"))).toEqual({
      reason: GENDER,
      detail: "termino=hijita (Chispa: masculino)",
    });
    // Con el género que corresponde a cada destinataria o destinatario, las mismas frases se aceptan.
    expect(reject("Pues eso es lo que tiene jugar con las que más quieres, hija", say("ai-green", "ai-pink"))).toBeNull();
    expect(reject("La vida son juegos, hijo, y las fichas se van.", say("ai-green", "ai-blue"))).toBeNull();
  });

  it("los dos sentidos con los cuatro destinatarios, también Don Ernesto", () => {
    for (const [speaker, rival, text, ok] of [
      ["ai-green", "ai-pink", "Ay, hija, a casita.", true],
      ["ai-green", "ai-pink", "Ay, hijito, a casita.", false],
      ["ai-green", "ai-blue", "Ay, hijo, a casita.", true],
      ["ai-green", "ai-blue", "Ay, hijita, a casita.", false],
      ["ai-green", "ai-purple", "Ay, hijo mío, a casita.", true],
      ["ai-green", "ai-purple", "Ay, hija mía, a casita.", false],
      ["ai-green", "ai-purple", "¡Mi niño, qué suerte!", true],
      ["ai-green", "ai-purple", "¡Mi niña, qué suerte!", false],
      ["ai-purple", "ai-green", "Lo siento, querida. Su ficha vuelve a casa.", true],
      ["ai-purple", "ai-green", "Lo siento, querido. Su ficha vuelve a casa.", false],
      ["ai-pink", "ai-blue", "¡A casa, guapo!", true],
      ["ai-pink", "ai-blue", "¡A casa, guapa!", false],
      ["ai-blue", "ai-pink", "¡Oye, maja, qué puntería!", true],
      ["ai-blue", "ai-pink", "¡Oye, majo, qué puntería!", false],
      ["ai-blue", "ai-purple", "¡Toma ya, campeón!", true],
      ["ai-blue", "ai-purple", "¡Toma ya, campeona!", false],
    ] as const) {
      const issue = checkQuality(text, say(speaker, rival));
      if (ok) expect(issue, `${speaker} → ${rival}: ${text}`).toBeNull();
      else expect(issue, `${speaker} → ${rival}: ${text}`).toMatchObject({ reason: GENDER });
    }
  });

  it("en una réplica, el destinatario es quien dijo el mensaje (el rival de la réplica)", () => {
    const reply = { kind: "capture_lament" as const, replyTo: 0 };
    expect(checkQuality("Ay, hija, qué poca vergüenza.", say("ai-green", "ai-pink", reply))).toBeNull();
    expect(checkQuality("Ay, hijita, qué poca vergüenza.", say("ai-green", "ai-blue", reply))).toMatchObject({ reason: GENDER, term: "hijita (Chispa: masculino)" });
  });

  it("no cuentan los plurales, los apelativos neutros, los usos que no son vocativos ni la victoria sin rival", () => {
    for (const rival of ["ai-pink", "ai-blue", "ai-purple"]) {
      for (const text of ["Con calma, hijos, que esto es largo.", "Ay, cariño, a casita.", "Perdona, cielo, es el juego.", "Hoy te ha salido todo.", "Qué bonita jugada.", "Mi nieta juega así.", "Una hija de la suerte, eso es lo que eres."]) {
        expect(checkQuality(text, say("ai-green", rival)), `${rival}: ${text}`).toBeNull();
      }
    }
    // Sin rival no hay destinatario con el que comparar: «Ay, hijo» es una interjección.
    expect(checkQuality("¡Gané, hija! Sin prisa se llega lejos.", say("ai-green", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
  });

  it("el motivo nuevo está en la lista que se registra", () => {
    expect(INVALID_RESPONSE_REASONS).toContain(GENDER);
  });
});

describe("final de la partida (con el estado real)", () => {
  const FIN = { reason: "afirmación no respaldada", term: "fin de la partida" };
  const victoryReply = (gameStatus?: "playing" | "finished") => ({
    ...say("ai-pink", "ai-blue", { kind: "victory_reply", trigger: "victory", replyTo: 0 }),
    ...(gameStatus ? { gameStatus } : {}),
  });
  const victoryWin = (gameStatus?: "playing" | "finished") => ({
    ...say("ai-blue", null, { kind: "victory_win", trigger: "victory" }),
    ...(gameStatus ? { gameStatus } : {}),
  });

  it("regresión 010c5ace (v745): «No esperaba la partida terminada así» con la partida en juego se rechaza", () => {
    expect(reject("¡Chispa, qué jugada más dura! No esperaba la partida terminada así.", victoryReply("playing"))).toEqual({
      reason: "afirmación no respaldada",
      detail: "termino=fin de la partida",
    });
  });

  it("con el estado real «playing» se rechaza afirmar que la partida ha terminado, en sus distintas formas", () => {
    for (const text of [
      "La partida ha terminado, Chispa.",
      "Se acabó la partida, Chispa.",
      "Ya se ha terminado la partida.",
      "Pues nada, se terminó la partida.",
      "¡Fin de la partida!",
      "Esta partida ya terminó, Chispa.",
      "Partida acabada, qué le vamos a hacer.",
      "Juego terminado, Chispa.",
    ]) {
      expect(checkQuality(text, victoryReply("playing")), text).toEqual(FIN);
    }
  });

  it("se acepta la victoria individual aunque los demás sigan jugando", () => {
    for (const text of ["¡He ganado la partida!", "¡Gané! La partida es mía.", "¡Meta! La partida ya es mía.", "¡Primero en llegar!"]) {
      expect(checkQuality(text, victoryWin("playing")), text).toBeNull();
    }
    expect(checkQuality("¡Enhorabuena, Chispa! Has ganado la partida.", victoryReply("playing"))).toBeNull();
  });

  it("se aceptan jugadas, movimientos, turnos o fichas terminados, la negación y el final para uno mismo", () => {
    for (const text of [
      "Mi jugada ha terminado, Chispa.",
      "Movimiento terminado y ficha en la meta.",
      "Se acabó mi turno, Chispa.",
      "Ficha en la meta: esa ya ha terminado.",
      "La partida no ha terminado, Chispa.",
      "Todavía no se ha acabado la partida.",
      "Esto aún no se ha acabado, Chispa.",
      "Antes de que acabe la partida, te pillo.",
      "Se acabó la partida para mí, pero no para ti.",
    ]) {
      expect(checkQuality(text, victoryReply("playing")), text).toBeNull();
    }
  });

  it("sin estado, o con la partida terminada de verdad, no se concluye nada", () => {
    for (const text of ["Se acabó la partida, Chispa.", "No esperaba la partida terminada así."]) {
      expect(checkQuality(text, victoryReply()), `sin estado: ${text}`).toBeNull();
      expect(checkQuality(text, victoryReply("finished")), `terminada: ${text}`).toBeNull();
    }
  });
});

describe("«racha» y «seguidos» coloquiales: suerte y dado frente a afirmaciones sobre capturas", () => {
  const NO = "afirmación no respaldada";
  const capture = [{ v: 10, by: "ai-pink", victim: "ai-blue" }];
  // Brava acaba de capturar a Chispa (una sola captura: nadie está de racha).
  const boast = say("ai-pink", "ai-blue", { kind: "capture_boast", captures: captureFacts(capture, 10, "ai-pink", "ai-blue", "ai-pink") });
  const lament = say("ai-blue", "ai-pink", { kind: "capture_lament", captures: captureFacts(capture, 10, "ai-pink", "ai-blue", "ai-blue") });
  // Réplicas: Chispa (víctima) responde a Brava, y Brava (quien captura) responde a Chispa.
  const replyLament = say("ai-blue", "ai-pink", { kind: "capture_lament", replyTo: 0, captures: captureFacts(capture, 10, "ai-pink", "ai-blue", "ai-blue") });
  const replyBoast = say("ai-pink", "ai-blue", { kind: "capture_boast", replyTo: 0, captures: captureFacts(capture, 10, "ai-pink", "ai-blue", "ai-pink") });
  const incomplete = say("ai-blue", "ai-pink", { kind: "capture_lament", captures: { history: "incomplete", selfRole: "victim" } });

  it("se aceptan la suerte y el dado en mensajes principales y réplicas, con distintas puntuaciones", () => {
    const anyRole = [
      "¡Qué racha de suerte con el dado!",
      "¡Qué racha de suerte con el dado!!",
      "qué racha de suerte con el dado",
      "Qué racha de buena suerte.",
      "Menuda racha con el dado.",
      "Dos seises seguidos.",
      "¡Dos seises seguidos!",
      "dos seises seguidos",
      "¿Dos seises seguidos?",
      "Tres tiradas seguidas sin sacar nada.",
      "Hoy no me salen las tiradas.",
    ];
    for (const ctx of [boast, lament, replyLament, replyBoast]) {
      for (const text of anyRole) expect(checkQuality(text, ctx), `${ctx.utterance.kind}${ctx.utterance.replyTo === null ? "" : " (réplica)"}: ${text}`).toBeNull();
    }
  });

  it("«mala racha» se acepta en el lado que pierde (mensaje y réplica), también con el historial incompleto", () => {
    for (const text of ["Vaya mala racha llevo hoy.", "¡Vaya mala racha llevo hoy!", "vaya mala racha llevo hoy", "Vaya mala racha llevo hoy…", "Qué racha de mala suerte."]) {
      for (const ctx of [lament, replyLament, incomplete]) expect(checkQuality(text, ctx), `${ctx.utterance.kind}: ${text}`).toBeNull();
    }
    // Con el historial incompleto, la suerte y el dado tampoco se rechazan (no hablan de capturas).
    expect(checkQuality("¡Qué racha de suerte con el dado!", incomplete)).toBeNull();
    expect(checkQuality("Dos seises seguidos.", incomplete)).toBeNull();
  });

  it("«mala racha» dicha por quien acaba de capturar es contradictoria y se sigue rechazando (#23)", () => {
    for (const ctx of [boast, replyBoast]) {
      expect(checkQuality("Vaya mala racha llevo hoy.", ctx)).toEqual({ reason: NO, term: "racha" });
    }
    expect(reject("¡Mala racha, Don Ernesto! Hoy no es mi día.", say("ai-blue", "ai-purple"))).toEqual({ reason: NO, detail: "termino=racha" });
  });

  it("se siguen rechazando las afirmaciones sobre capturas, rachas reales y su estado", () => {
    for (const [text, term] of [
      ["Llevo tres capturas seguidas.", "cifra 3 (real 1, hechas por quien habla)"],
      ["¡Llevo tres capturas seguidas!", "cifra 3 (real 1, hechas por quien habla)"],
      ["Ya van dos fichas seguidas.", "seguidas (sin racha)"],
      ["Tu racha de capturas continúa.", "racha que sigue"],
      ["Se ha terminado tu racha.", "fin de racha"],
      ["¡Vaya racha!", "racha"],
      ["Mi racha de suerte sigue, Chispa.", "racha que sigue"],
      ["Qué racha de suerte: te he comido otra vez.", "racha"],
      ["Dos seises seguidos y tres capturas seguidas.", "cifra 3 (real sin racha)"],
    ] as const) {
      expect(checkQuality(text, boast), text).toEqual({ reason: NO, term });
    }
    // En la réplica de quien pierde, igual.
    expect(checkQuality("Ya van dos fichas seguidas.", replyLament)).toEqual({ reason: NO, term: "seguidas (sin racha)" });
    expect(checkQuality("Se ha terminado tu racha.", replyLament)).toEqual({ reason: NO, term: "fin de racha" });
  });

  it("por el flujo completo (cleanLlmText): la suerte y el dado se publican; una racha sin respaldo, no", () => {
    expect(reject("¡Qué racha de suerte con el dado, Chispa!", boast)).toBeNull();
    expect(reject("Dos seises seguidos, Brava. Qué nervios.", lament)).toBeNull();
    expect(reject("Vaya mala racha llevo hoy, Brava.", lament)).toBeNull();
    expect(reject("Tu racha de capturas continúa, Chispa.", boast)).toEqual({ reason: NO, detail: "termino=racha que sigue" });
  });
});

describe("D1 y D2: la excepción del dado y la de la suerte exigen que no haya vocabulario de capturas", () => {
  const NO = "afirmación no respaldada";
  const capture = [{ v: 10, by: "ai-pink", victim: "ai-blue" }];
  const facts = (speaker: string) => captureFacts(capture, 10, "ai-pink", "ai-blue", speaker);
  // Mensajes principales y réplicas de los dos lados (Brava acaba de capturar a Chispa: una sola captura).
  const contexts = [
    say("ai-pink", "ai-blue", { kind: "capture_boast", captures: facts("ai-pink") }),
    say("ai-blue", "ai-pink", { kind: "capture_lament", captures: facts("ai-blue") }),
    say("ai-pink", "ai-blue", { kind: "capture_boast", replyTo: 0, captures: facts("ai-pink") }),
    say("ai-blue", "ai-pink", { kind: "capture_lament", replyTo: 0, captures: facts("ai-blue") }),
  ];
  const incomplete = [
    say("ai-pink", "ai-blue", { kind: "capture_boast", captures: { history: "incomplete", selfRole: "by" } }),
    say("ai-blue", "ai-pink", { kind: "capture_lament", replyTo: 0, captures: { history: "incomplete", selfRole: "victim" } }),
  ];
  const where = (ctx: (typeof contexts)[number]) => `${ctx.utterance.kind}${ctx.utterance.replyTo === null ? "" : " (réplica)"}${ctx.utterance.captures?.history === "incomplete" ? " incompleto" : ""}`;

  it("D1: las secuencias del dado sin capturas se siguen aceptando (historial completo e incompleto, puntuación variada)", () => {
    for (const text of [
      "Dos seises seguidos.",
      "¡Dos seises seguidos!",
      "Tres tiradas seguidas sin sacar nada.",
      "tres tiradas seguidas sin sacar nada…",
      "Dos cincos seguidos.",
      "¿Dos cincos seguidos? Qué cosas.",
      "Uf. Dos seises seguidos, y yo sin moverme.",
    ]) {
      for (const ctx of [...contexts, ...incomplete]) expect(checkQuality(text, ctx), `${where(ctx)}: ${text}`).toBeNull();
    }
  });

  it("D1: con vocabulario de capturas, «seguidas» tras una palabra del dado se comprueba y se rechaza (completo e incompleto)", () => {
    for (const text of [
      "Te he capturado en dos tiradas seguidas.",
      "Te pillo dos tiradas seguidas, Chispa.",
      "Dos tiradas seguidas comiéndote.",
      "¡Dos tiradas seguidas comiéndote!",
      "Dos tiradas seguidas: te he comido, Chispa.",
      "Dos tiradas seguidas… y a casa otra vez.",
      "Dos seises seguidos. Te cacé, Chispa.",
    ]) {
      for (const ctx of contexts) expect(checkQuality(text, ctx), `${where(ctx)}: ${text}`).toMatchObject({ reason: NO });
      for (const ctx of incomplete) expect(checkQuality(text, ctx), `${where(ctx)}: ${text}`).toMatchObject({ reason: NO });
    }
    // El término identifica la palabra comprobada (con historial completo la rechaza `checkGameTalk`: no hay
    // ninguna racha que respalde «seguidas»; con el incompleto, ya `checkCountClaims`).
    expect(checkQuality("Te he capturado en dos tiradas seguidas.", contexts[0])).toEqual({ reason: NO, term: "seguidas" });
    expect(checkQuality("Te he capturado en dos tiradas seguidas.", incomplete[0])).toEqual({ reason: NO, term: "seguidas (historial incompleto)" });
  });

  it("D1: la excepción nunca elude las cifras de capturas", () => {
    expect(checkQuality("Llevo tres capturas en tres tiradas seguidas.", contexts[0])).toEqual({ reason: NO, term: "cifra 3 (real 1, hechas por quien habla)" });
    expect(checkQuality("Dos seises seguidos y tres capturas seguidas.", contexts[0])).toMatchObject({ reason: NO, term: expect.stringMatching(/^cifra 3/) });
  });

  it("D2: «a casita» y «cazar» con c (cacé, caces, cacemos, cacen) son vocabulario de capturas, también con la suerte", () => {
    for (const text of [
      "¡Qué racha de suerte! A casita, Chispa.",
      "Qué racha de suerte… a casita, cariño.",
      "¡Qué racha de suerte! Te cacé, Chispa.",
      "Qué racha de suerte: si te caces sola, mejor.",
      "Qué racha de suerte, ya te cacemos luego.",
      "Qué racha de suerte. Que te cacen otros.",
      "Qué racha de suerte con el dado, y a casita que te vas.",
    ]) {
      expect(checkQuality(text, contexts[0]), text).toEqual({ reason: NO, term: "racha" });
      expect(checkQuality(text, contexts[2]), `réplica: ${text}`).toEqual({ reason: NO, term: "racha" });
    }
    // Sin vocabulario de capturas, la suerte se sigue aceptando (palabras parecidas no cuentan).
    for (const text of ["¡Qué racha de suerte con el dado!", "Qué racha de suerte en esta casa.", "Qué racha de suerte, cacharro de dado."]) {
      expect(checkQuality(text, contexts[0]), text).toBeNull();
    }
  });

  it("lo que ya funcionaba sigue igual: #23 rechazado y la mala racha en el lado que pierde aceptada", () => {
    expect(reject("¡Mala racha, Don Ernesto! Hoy no es mi día.", say("ai-blue", "ai-purple"))).toEqual({ reason: NO, detail: "termino=racha" });
    expect(checkQuality("Vaya mala racha llevo hoy, Brava.", contexts[1])).toBeNull();
    expect(checkQuality("Vaya mala racha llevo hoy, Brava.", contexts[3])).toBeNull();
  });
});

describe("naturalidad: expresiones artificiales de la partida de Preview (frases del LLM)", () => {
  const capture = [{ v: 10, by: "ai-pink", victim: "ai-blue" }];
  const facts = (speaker: string) => captureFacts(capture, 10, "ai-pink", "ai-blue", speaker);
  const bravaBoast = say("ai-pink", "ai-blue", { kind: "capture_boast", captures: facts("ai-pink") });
  const chispaLament = say("ai-blue", "ai-pink", { kind: "capture_lament", captures: facts("ai-blue") });
  const pilarReply = say("ai-green", "ai-blue", { kind: "capture_boast", replyTo: 0 });
  const ernestoBoast = say("ai-purple", "ai-pink", { kind: "capture_boast" });

  it("los ejemplos vistos se rechazan con su motivo", () => {
    expect(checkQuality("¡Dadme ese seis, por favor!", chispaLament)).toEqual({ reason: "expresión poco natural", term: "petición al dado" });
    expect(checkQuality("Otro golpe, Chispa. No te rindas aún.", pilarReply)).toEqual({ reason: "expresión poco natural", term: "golpe" });
    expect(checkQuality("Qué bien lo haces, Brava. ¡Vamos por la quinta!", chispaLament)).toEqual({ reason: "afirmación no respaldada", term: "objetivo quinta" });
    expect(checkQuality("¡Mía! No me la quites.", chispaLament)).toEqual({ reason: "expresión poco natural", term: "no me la quites" });
    expect(checkQuality("La presión constante da sus frutos, Brava.", ernestoBoast)).toEqual({ reason: "expresión poco natural", term: "da sus frutos" });
  });

  it("variantes con otra puntuación, mayúsculas y en réplicas", () => {
    for (const [text, ctx] of [
      ["Dame un seis, dado, que lo necesito.", chispaLament],
      ["DADME ESE SEIS POR FAVOR", chispaLament],
      ["Venga, dado, por favor: un seis.", pilarReply],
      ["Vaya golpe, Chispa…", pilarReply],
      ["Menudos golpes me das, Brava.", chispaLament],
    ] as const) {
      expect(checkQuality(text, ctx), text).toMatchObject({ reason: "expresión poco natural" });
    }
    for (const text of ["¡A por la tercera!", "Vamos a por la segunda, Brava."]) {
      expect(checkQuality(text, chispaLament), text).toMatchObject({ reason: "afirmación no respaldada", term: expect.stringMatching(/^objetivo /) });
    }
  });

  it("se aceptan las expresiones naturales del parchís y los usos correctos de esas palabras", () => {
    for (const [text, ctx] of [
      ["¡Te comí, Chispa!", bravaBoast],
      ["Me comiste, Brava. Ya te pillaré.", chispaLament],
      ["Le comí la ficha, Brava. Era de esperar.", ernestoBoast],
      ["Golpe de suerte con el dado, Chispa.", pilarReply],
      ["Me has comido de golpe, Brava.", chispaLament],
      ["Venga, a ver si sale un seis.", chispaLament],
      ["Por favor, Brava, no corras tanto.", chispaLament],
    ] as const) {
      expect(checkQuality(text, ctx), text).toBeNull();
    }
    // «no me la quites» solo se rechaza en una captura.
    expect(checkQuality("No me la quites, que es mía.", say("ai-blue", "ai-pink", { kind: "victory_reply", trigger: "victory" }))).toBeNull();
  });

  it("el motivo nuevo está en la lista que se registra", () => {
    expect(INVALID_RESPONSE_REASONS).toContain("expresión poco natural");
  });
});

describe("hasDiscardedExpression: expresiones descartadas que no se citan en el prompt", () => {
  it("reconoce las de Preview y las quitadas del catálogo, con cualquier puntuación", () => {
    for (const text of [
      "¡En cabeza y sin frenar! ¿Quién me sigue?",
      "Voy primera y no pienso aflojar.",
      "¿Esto es todo lo que tenéis?",
      "La presión constante da sus frutos, Brava.",
      "¡Dadme ese seis, por favor!",
      "Otro golpe, Chispa. No te rindas aún.",
      "Qué bien lo haces, Chispa. ¡Vamos por la quinta!",
      "¡Mía! No me la quites.",
      "¡Que tiemble el tablero!",
      "Esto es Parchís, señores.",
      "Jaque mate, Brava.",
      "¡Gol de Chispa!",
    ]) {
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("no descarta las expresiones naturales ni ninguna frase actual del catálogo", () => {
    for (const text of ["¡Te comí, Chispa!", "Me comiste, Brava.", "Golpe de suerte con el dado.", "Me has comido de golpe.", "Por favor, Brava, no corras tanto."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
    for (const c of CHARACTERS) {
      for (const lines of Object.values(c.chat.lines)) for (const line of lines) expect(hasDiscardedExpression(line), `${c.name}: ${line}`).toBe(false);
    }
  });
});

describe("naturalidad: diminutivos, «me tiré un cuatro», «en la calle» y Don Ernesto de usted", () => {
  const UNNATURAL = "expresión poco natural";
  const TUTEA = "tutea (Don Ernesto)";
  const TRIGGER_OF_KIND: Record<string, ChatTrigger> = {
    victory_win: "victory",
    victory_reply: "victory",
    capture_boast: "capture",
    capture_lament: "capture",
    streak_boast: "capture_streak",
    streak_lament: "bad_streak",
    third_six_self: "third_six",
    third_six_tease: "third_six",
    goal: "goal",
    finish_place: "finish_place",
    ambient_lead: "ambient",
    ambient_ahead: "ambient",
    ambient_behind: "ambient",
  };

  it("regresión: los tres ejemplos se rechazan (flujo completo de cleanLlmText)", () => {
    expect(reject("¡Me comí la tuya y me tiré un cuatro!", say("ai-pink", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=tirarse un número" });
    expect(reject("Su fichita quedó en la calle.", say("ai-green", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=en la calle" });
    expect(reject("¿Tiraste un seis, Abuela Pilar?", say("ai-purple", "ai-green", { kind: "capture_lament" }))).toEqual({ reason: TUTEA, detail: "termino=tiraste" });
  });

  it("cada parte por separado", () => {
    expect(reject("Su fichita vuelve a casa, Chispa.", say("ai-green", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=diminutivo fichita" });
    expect(reject("Su ficha se queda en la calle, Chispa.", say("ai-green", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=en la calle" });
    for (const text of ["Te tiraste un seis, Chispa.", "Se tiró un cinco y me comió, Chispa.", "¡Me he tirado un seis!", "Nos tiramos dos seises, Chispa."]) {
      expect(reject(text, say("ai-pink", "ai-blue")), text).toEqual({ reason: UNNATURAL, detail: "termino=tirarse un número" });
    }
  });

  it("Don Ernesto nunca tutea, tampoco en preguntas ni réplicas cortas", () => {
    for (const [text, term] of [
      ["¿Sacaste un seis, Chispa?", "sacaste"],
      ["Me comiste, Brava. Bien jugado.", "comiste"],
      ["¿Tiras ya, Chispa?", "tiras"],
      ["Siempre llegas tarde, Brava.", "llegas"],
      ["¿Lo pillas, Chispa?", "pillas"],
    ] as const) {
      const r = reject(text, say("ai-purple", text.includes("Brava") ? "ai-pink" : "ai-blue", { kind: "capture_lament", replyTo: 0 }));
      expect(r, text).toEqual({ reason: TUTEA, detail: `termino=${term}` });
    }
    // De usted, y palabras que solo lo parecen.
    for (const text of [
      "¿Ha sacado un seis, Abuela Pilar?",
      "Me ha comido usted, Abuela Pilar. Bien jugado.",
      "Existe una probabilidad razonable, Abuela Pilar.",
      "Qué triste jugada la mía, Abuela Pilar.",
      "Juego con ganas, Abuela Pilar.",
      "Sus capturas no me inquietan, Abuela Pilar.",
    ]) {
      expect(reject(text, say("ai-purple", "ai-green", { kind: "capture_lament" })), text).toBeNull();
    }
    // La regla es solo de Don Ernesto.
    expect(reject("¿Sacaste un seis, Chispa?", say("ai-pink", "ai-blue", { kind: "capture_lament" }))).toBeNull();
  });

  it("diminutivos: nadie salvo Pilar, y ella solo «casita» cuando una ficha vuelve a casa y sus dos frases hechas", () => {
    for (const speaker of ["ai-pink", "ai-purple", "ai-blue"]) {
      for (const text of ["¡A casita, Abuela Pilar!", "Un poquito de suerte, Abuela Pilar.", "Despacito y buena letra, Abuela Pilar."]) {
        expect(reject(text, say(speaker, "ai-green")), `${speaker}: ${text}`).toMatchObject({ reason: UNNATURAL });
      }
    }
    // Pilar: «casita» en capturas y rachas, sí; en la meta, el tercer 6 o el ambiente, no.
    for (const trigger of ["capture", "capture_streak", "bad_streak"] as const) {
      expect(checkQuality("Ay, Chispa, a casita.", say("ai-green", "ai-blue", { trigger })), trigger).toBeNull();
    }
    for (const trigger of ["goal", "third_six", "ambient", "victory"] as const) {
      expect(checkQuality("Ay, Chispa, a casita.", say("ai-green", "ai-blue", { trigger })), trigger).toEqual({ reason: UNNATURAL, term: "diminutivo casita" });
    }
    // Sus dos frases hechas, sí; el diminutivo suelto, no.
    expect(checkQuality("Despacito y buena letra, Chispa.", say("ai-green", "ai-blue"))).toBeNull();
    expect(checkQuality("Poquito a poco, Chispa.", say("ai-green", "ai-blue"))).toBeNull();
    for (const [text, word] of [["Despacito, Chispa.", "despacito"], ["Un poquito más, Chispa.", "poquito"], ["Ay, hijito, qué cosas.", "hijito"], ["Un ratito más, Chispa.", "ratito"], ["Mi abuelita lo decía, Chispa.", "abuelita"]] as const) {
      expect(disallowedDiminutive(text, "ai-green", "capture"), text).toBe(word);
    }
    // Palabras normales que no son diminutivos.
    for (const text of ["La ficha entra en el pasillo, Chispa.", "Qué bonita jugada, Chispa.", "Una cosa: a casa, Chispa.", "Paso a paso, Chispa.", "Solo un rato, Chispa."]) {
      expect(disallowedDiminutive(text, "ai-pink", "capture"), text).toBeNull();
    }
  });

  it("las formas naturales de hablar del dado se aceptan", () => {
    for (const text of ["He sacado un cuatro y te comí, Chispa.", "¡Me ha salido un seis! A casa, Chispa.", "He tirado y me ha salido un seis, Chispa.", "Tiré un cuatro y te comí, Chispa."]) {
      expect(reject(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    expect(reject("Le ha salido un seis, Abuela Pilar. Le comí.", say("ai-purple", "ai-green"))).toBeNull();
  });

  it("hasDiscardedExpression no cita las formas nuevas y sí las frases de Pilar", () => {
    for (const text of ["¡Me comí la tuya y me tiré un cuatro!", "Su fichita quedó en la calle.", "Se queda en la calle, Chispa.", "Despacito, Chispa.", "Un ratito más."]) {
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
    for (const text of ["Ay, Chispa, a casita.", "Despacito y buena letra.", "Poquito a poco, Chispa.", "He sacado un cuatro."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("el catálogo local cumple: diminutivos solo los de Pilar permitidos y Don Ernesto siempre de usted", () => {
    for (const c of CHARACTERS) {
      for (const [kind, lines] of Object.entries(c.chat.lines)) {
        for (const line of lines) {
          expect(disallowedDiminutive(line, c.id, TRIGGER_OF_KIND[kind]), `${c.name}/${kind}: ${line}`).toBeNull();
        }
      }
    }
    const ernesto = CHARACTERS.find((c) => c.id === "ai-purple")!;
    for (const [kind, lines] of Object.entries(ernesto.chat.lines)) {
      for (const line of lines) {
        const text = line.replaceAll("{rival}", "Abuela Pilar").replaceAll("{Count}", "Dos").replaceAll("{count}", "dos").replaceAll("{ritmo}", "seguidas");
        const issue = checkQuality(text, say("ai-purple", "ai-green", { kind: kind as Utterance["kind"], trigger: TRIGGER_OF_KIND[kind] }));
        expect(issue?.reason, `${kind}: ${text}`).not.toBe(TUTEA);
      }
    }
  });
});

describe("frases repetidas de las pruebas reales y «¡Voy ganando!» de Chispa", () => {
  const UNNATURAL = "expresión poco natural";
  const ambient = (speaker: string, kind: Utterance["kind"] = "ambient_ahead") => say(speaker, null, { kind, trigger: "ambient", important: false });

  it("regresión: las dos frases se rechazan, digan quien las diga (flujo completo de cleanLlmText)", () => {
    expect(reject("La partida sigue muy abierta. Habrá que estar atentos.", ambient("ai-purple"))).toEqual({ reason: UNNATURAL, detail: "termino=partida abierta" });
    for (const speaker of ["ai-pink", "ai-blue", "ai-green", "ai-purple"]) {
      expect(checkQuality("Habrá que estar atentos.", ambient(speaker))).toEqual({ reason: UNNATURAL, term: "estar atentos" });
    }
    // En una racha real de Brava (tres seguidas), la cifra es correcta: lo que se rechaza es la coletilla.
    const streak = { kind: "streak_boast" as const, trigger: "capture_streak" as const, streak: { count: 3, consecutive: true } };
    const facts = factsOf([cap(10, "ai-pink", "ai-blue"), cap(11, "ai-pink", "ai-green"), cap(12, "ai-pink", "ai-blue")], "ai-pink");
    expect(reject("Tres seguidas y aún tengo hambre.", say("ai-pink", "ai-blue", { ...streak, captures: facts }))).toEqual({ reason: UNNATURAL, detail: "termino=aún tengo hambre" });
    expect(reject("Tres seguidas. ¡Y voy a por más!", say("ai-pink", "ai-blue", { ...streak, captures: facts }))).toBeNull();
  });

  it("variantes claramente equivalentes, también rechazadas", () => {
    for (const [text, term] of [
      ["La partida está muy abierta, Chispa.", "partida abierta"],
      ["La partida sigue abierta.", "partida abierta"],
      ["La partida continúa bastante abierta.", "partida abierta"],
      ["Hay que estar atentas, chicas.", "estar atentos"],
      ["Tendremos que estar atentos.", "estar atentos"],
      ["Y todavía tengo hambre.", "aún tengo hambre"],
      ["¡Aún me quedo con hambre!", "aún tengo hambre"],
      ["Sigo con hambre, Chispa.", "aún tengo hambre"],
    ] as const) {
      expect(checkQuality(text, ambient("ai-pink")), text).toEqual({ reason: UNNATURAL, term });
    }
  });

  it("no se bloquean frases naturales parecidas", () => {
    for (const text of ["Todavía queda mucha partida.", "Atento a esa ficha, Chispa.", "Estad atentos, que esto se pone bueno.", "¡Tengo hambre de fichas!", "Todo está por decidir. Lo calculo con calma.", "La partida es larga."]) {
      expect(checkQuality(text, ambient("ai-pink")), text).toBeNull();
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("nadie dice «voy en cabeza» (se dice «¡Voy ganando!»), ni se cita en el prompt", () => {
    // Afirmar la posición sin respaldo se rechaza antes de llegar al chat.
    expect(reject("¡Voy en cabeza! Que no se acabe la suerte.", say("ai-blue", "ai-pink"))).toEqual({ reason: "afirmación no respaldada", detail: "termino=voy en cabeza" });
    // Expresión retirada para todos, también en el historial citado.
    expect(hasDiscardedExpression("¡Voy en cabeza! Que no se acabe la suerte.")).toBe(true);
    expect(hasDiscardedExpression("Voy en cabeza. Hoy me salen las tiradas.")).toBe(true);
  });

  it("las frases antiguas se citaban como modelo y ya no se citan en el prompt", () => {
    for (const text of ["La partida sigue muy abierta. Habrá que estar atentos.", "Tres seguidas y aún tengo hambre."]) {
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("catálogo local: ninguna de las dos frases ni sus variantes, y Chispa usa «¡Voy ganando!» y nunca «en cabeza»", () => {
    const chispa = CHARACTERS.find((c) => c.id === "ai-blue")!;
    for (const c of CHARACTERS) {
      for (const lines of Object.values(c.chat.lines)) {
        for (const line of lines) {
          expect(line, `${c.name}: ${line}`).not.toMatch(/sigue muy abierta|estar atentos|tengo hambre/i);
          if (c === chispa) expect(line, line).not.toMatch(/en cabeza/i);
        }
      }
    }
    expect(chispa.chat.lines.ambient_lead).toContain("¡Voy ganando! Que no se acabe la suerte.");
    expect(chispa.chat.lines.ambient_lead.some((l) => /^¡?Voy ganando/.test(l))).toBe(true);
  });
});

describe("expresiones retiradas, «Voy ganando» con respaldo y capturas repetidas", () => {
  const UNNATURAL = "expresión poco natural";
  const unsupportedIssue = (term: string) => ({ reason: "afirmación no respaldada", term });
  const capture = (speaker: string, rival: string, extra: Partial<Utterance> = {}) => say(speaker, rival, extra);
  const lament = (speaker: string, rival: string, extra: Partial<Utterance> = {}) => say(speaker, rival, { kind: "capture_lament", ...extra });
  const withLeader = (request: Request, leader: string | null) => ({ ...request, leader });

  it("«¡Me la he quedado!» y sus variantes se rechazan (y no se citan en el prompt)", () => {
    for (const text of ["¡Me la he quedado!", "¡Esta me la quedo, Chispa!", "Me las quedo todas, Chispa.", "Voy a quedármela, Chispa.", "Me quedo con tu ficha, Chispa.", "¡Nos la quedamos!"]) {
      expect(checkQuality(text, capture("ai-pink", "ai-blue")), text).toEqual({ reason: UNNATURAL, term: "me la he quedado" });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
    expect(reject("¡Me la he quedado, Chispa!", capture("ai-pink", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=me la he quedado" });
    // Frases naturales parecidas.
    for (const text of ["Me he quedado sin turno, Brava.", "Me quedo con las ganas, Brava.", "Me quedo tranquila, Brava."]) {
      expect(checkQuality(text, lament("ai-blue", "ai-pink")), text).toBeNull();
    }
  });

  it("«contratiempo» (como «Un pequeño contratiempo, Chispa. Nada más.») se rechaza para todos", () => {
    expect(reject("Un pequeño contratiempo, Chispa. Nada más.", lament("ai-purple", "ai-blue"))).toEqual({ reason: UNNATURAL, detail: "termino=contratiempo" });
    for (const text of ["Solo es un contratiempo, Brava.", "Menudo contratiempo, Brava."]) {
      expect(checkQuality(text, lament("ai-blue", "ai-pink")), text).toEqual({ reason: UNNATURAL, term: "contratiempo" });
    }
    expect(hasDiscardedExpression("Un pequeño contratiempo, Chispa. Nada más.")).toBe(true);
  });

  it("«en cabeza» se rechaza siempre, aunque quien lo dice vaya ganando", () => {
    expect(checkQuality("Voy en cabeza, Chispa.", withLeader(capture("ai-pink", "ai-blue"), "ai-pink"))).toEqual(unsupportedIssue("voy en cabeza"));
    expect(checkQuality("La abuela va en cabeza, Chispa.", withLeader(capture("ai-green", "ai-blue"), "ai-green"))).toEqual(unsupportedIssue("va en cabeza"));
    expect(checkQuality("¡En cabeza, Chispa!", withLeader(capture("ai-pink", "ai-blue"), "ai-pink"))).toEqual(unsupportedIssue("en cabeza"));
    expect(hasDiscardedExpression("La abuela va en cabeza. Tomad nota, cariños.")).toBe(true);
  });

  it("«Voy ganando» solo si los datos reales dicen que quien habla va ganando (no por capturar)", () => {
    const text = "¡Te comí, Chispa! Voy ganando.";
    // Sin el dato, con otro en cabeza, o sin nadie en cabeza: no.
    expect(checkQuality(text, capture("ai-pink", "ai-blue"))).toEqual(unsupportedIssue("voy ganando"));
    expect(checkQuality(text, withLeader(capture("ai-pink", "ai-blue"), "ai-green"))).toEqual(unsupportedIssue("voy ganando"));
    expect(checkQuality(text, withLeader(capture("ai-pink", "ai-blue"), null))).toEqual(unsupportedIssue("voy ganando"));
    // Con Brava en cabeza de verdad, sí (flujo completo).
    expect(reject(text, withLeader(capture("ai-pink", "ai-blue"), "ai-pink"))).toBeNull();
    // «vas/va ganando» solo del rival, si es él quien va ganando.
    expect(checkQuality("Vas ganando, Brava, pero esta es mía.", withLeader(lament("ai-blue", "ai-pink"), "ai-pink"))).toBeNull();
    expect(checkQuality("Vas ganando, Brava, pero esta es mía.", withLeader(lament("ai-blue", "ai-pink"), "ai-blue"))).toEqual(unsupportedIssue("vas ganando"));
    // El resto de afirmaciones de posición sigue rechazado aunque vaya ganando.
    expect(checkQuality("Voy primera, Chispa.", withLeader(capture("ai-pink", "ai-blue"), "ai-pink"))).toEqual(unsupportedIssue("voy primera"));
    expect(checkQuality("Vas perdiendo, Chispa.", withLeader(capture("ai-pink", "ai-blue"), "ai-pink"))).toEqual(unsupportedIssue("vas perdiendo"));
  });

  it("«me comiste la ficha de nuevo» y equivalentes solo con dos capturas reales de esa pareja", () => {
    const once = factsOf([cap(10, "ai-pink", "ai-blue")], "ai-blue");
    const twice = factsOf([cap(10, "ai-pink", "ai-blue"), cap(20, "ai-pink", "ai-blue")], "ai-blue");
    const otherRival = factsOf([cap(10, "ai-green", "ai-blue"), cap(20, "ai-pink", "ai-blue")], "ai-blue");
    const variants = [
      "Maldición, me comiste la ficha de nuevo, Brava.",
      "Otra vez me pillas, Brava.",
      "Me has comido otra ficha, Brava.",
      "Me vuelves a comer, Brava.",
      "Me has mandado a casa otra vez, Brava.",
    ];
    for (const text of variants) {
      expect(checkQuality(text, lament("ai-blue", "ai-pink", { captures: once })), text).toEqual(unsupportedIssue("captura repetida"));
      expect(checkQuality(text, lament("ai-blue", "ai-pink", { captures: otherRival })), text).toEqual(unsupportedIssue("captura repetida"));
      expect(checkQuality(text, lament("ai-blue", "ai-pink", { captures: { history: "incomplete", selfRole: "victim" } })), text).toEqual(unsupportedIssue("captura repetida"));
      expect(checkQuality(text, lament("ai-blue", "ai-pink", { captures: twice })), text).toBeNull();
    }
    // Desde quien captura: «te he comido otra vez» cuenta sus capturas a ese rival.
    const brava = factsOf([cap(10, "ai-pink", "ai-blue")], "ai-pink");
    expect(checkQuality("Te he comido otra vez, Chispa.", capture("ai-pink", "ai-blue", { captures: brava }))).toEqual(unsupportedIssue("captura repetida"));
    // Sin repetición: la frase de Chispa, y «de nuevo» u «otra vez» lejos del verbo de captura.
    expect(reject("Maldición, me comiste la ficha, Brava.", lament("ai-blue", "ai-pink", { captures: once }))).toBeNull();
    expect(checkQuality("¡Te pillé, Brava! A empezar de nuevo.", capture("ai-blue", "ai-pink", { captures: factsOf([cap(10, "ai-blue", "ai-pink")], "ai-blue") }))).toBeNull();
    expect(checkQuality("¿Otra vez? ¡Me tenéis manía!", lament("ai-pink", "ai-blue", { captures: factsOf([cap(10, "ai-blue", "ai-pink")], "ai-pink") }))).toBeNull();
  });

  it("catálogo: ninguna expresión retirada, «ganando» solo en `ambient_lead` y la frase de Chispa sin «de nuevo»", () => {
    for (const c of CHARACTERS) {
      for (const [kind, lines] of Object.entries(c.chat.lines)) {
        for (const line of lines) {
          expect(line, `${c.name}: ${line}`).not.toMatch(/en cabeza|contratiempo|me las? (he )?qued|quedármela|me comiste la ficha de nuevo|vuelto a comer/i);
          expect(hasDiscardedExpression(line), `${c.name}: ${line}`).toBe(false);
          if (/ganando/i.test(line)) expect(kind, `${c.name}: ${line}`).toBe("ambient_lead");
        }
      }
    }
    const chispa = CHARACTERS.find((c) => c.id === "ai-blue")!;
    expect(chispa.chat.lines.capture_lament).toContain("Maldición, me comiste la ficha, {rival}.");
    expect(CHARACTERS.find((c) => c.id === "ai-pink")!.chat.lines.ambient_lead).toContain("Voy ganando. Hoy me salen las tiradas.");
    expect(CHARACTERS.find((c) => c.id === "ai-green")!.chat.lines.ambient_lead).toContain("La abuela va ganando. Tomad nota, hijos.");
  });
});

describe("dirección de las capturas, el propio nombre y expresiones retiradas (conversación real)", () => {
  const NAMES: Record<string, string> = { "ai-pink": "Brava", "ai-purple": "Don Ernesto", "ai-green": "Abuela Pilar", "ai-blue": "Chispa" };
  const IDS = Object.keys(NAMES);
  const DIRECTION = "contradice quién captura";
  const SELF = "se dirige a sí mismo";
  /** Mensaje de quien captura (`by`) a su víctima, o réplica de la víctima a quien captura, con los hechos reales. */
  const capturer = (speaker: string, victim: string, log = [cap(10, speaker, victim)]) =>
    say(speaker, victim, { kind: "capture_boast", captures: factsOf(log, speaker) });
  const victimOf = (speaker: string, by: string, log = [cap(10, by, speaker)]) =>
    say(speaker, by, { kind: "capture_lament", captures: factsOf(log, speaker) });

  it("habla quien captura: «Te comí» / «He comido tu ficha» (Don Ernesto, de usted: «Le he comido una ficha» / «He comido su ficha»)", () => {
    for (const speaker of IDS) {
      for (const victim of IDS.filter((id) => id !== speaker)) {
        const forms = speaker === "ai-purple" ? ["Le he comido una ficha", "He comido su ficha"] : ["Te comí", "He comido tu ficha"];
        for (const form of forms) expect(reject(`${form}, ${NAMES[victim]}.`, capturer(speaker, victim)), `${NAMES[speaker]} → ${NAMES[victim]}: ${form}`).toBeNull();
        // Al revés (como si la hubiera perdido): se rechaza.
        const wrong = speaker === "ai-purple" ? "Me ha comido una ficha" : "Me comiste";
        // (Con «una ficha», ya lo rechaza la regla de cifras: «una ficha» con el papel cambiado.)
        expect([DIRECTION, "afirmación no respaldada"], `${NAMES[speaker]}: ${wrong}`).toContain(checkQuality(`${wrong}, ${NAMES[victim]}.`, capturer(speaker, victim))?.reason);
      }
    }
  });

  it("habla quien pierde la ficha: «Me comiste» / «Me has comido una ficha» (Don Ernesto: «Me ha comido una ficha»)", () => {
    for (const speaker of IDS) {
      for (const by of IDS.filter((id) => id !== speaker)) {
        const forms = speaker === "ai-purple" ? ["Me ha comido una ficha"] : ["Me comiste", "Me has comido una ficha"];
        // Brava lo dice con exclamaciones («¡Me has comido una ficha, Chispa!»).
        const said = (form: string) => (speaker === "ai-pink" && form === "Me has comido una ficha" ? `¡${form}, ${NAMES[by]}!` : `${form}, ${NAMES[by]}.`);
        for (const form of forms) expect(reject(said(form), victimOf(speaker, by)), `${NAMES[speaker]} ← ${NAMES[by]}: ${form}`).toBeNull();
        const wrong = speaker === "ai-purple" ? "Le he comido una ficha" : "Te comí";
        expect([DIRECTION, "afirmación no respaldada"], `${NAMES[speaker]}: ${wrong}`).toContain(checkQuality(`${wrong}, ${NAMES[by]}.`, victimOf(speaker, by))?.reason);
      }
    }
  });

  it("Don Ernesto no puede usar las formas de tú, aunque la dirección sea correcta", () => {
    expect(reject("Te comí, Abuela Pilar.", capturer("ai-purple", "ai-green"))).toMatchObject({ reason: "tutea (Don Ernesto)" });
    expect(reject("Me comiste, Abuela Pilar.", victimOf("ai-purple", "ai-green"))).toMatchObject({ reason: "tutea (Don Ernesto)" });
  });

  it("los ejemplos de la conversación real", () => {
    // Don Ernesto se dirige a sí mismo.
    expect(reject("He comido su ficha, Don Ernesto.", capturer("ai-purple", "ai-green"))).toEqual({ reason: SELF, detail: "termino=don ernesto" });
    expect(reject("Pues nada, Don Ernesto, Abuela Pilar se come mi ficha.", victimOf("ai-purple", "ai-green"))).toEqual({ reason: SELF, detail: "termino=don ernesto" });
    // Abuela Pilar le ha comido a Don Ernesto: correcto.
    expect(reject("Te comí, Don Ernesto.", capturer("ai-green", "ai-purple"))).toBeNull();
    // «Lo siento, Abuela Pilar. Era la mejor jugada.»: coherente si Don Ernesto ha capturado; si la ficha la ha
    // perdido él (Pilar le acaba de comer), disculparse contradice el evento.
    expect(reject("Lo siento, Abuela Pilar. Era la mejor jugada.", capturer("ai-purple", "ai-green"))).toBeNull();
    expect(reject("Lo siento, Abuela Pilar. Era la mejor jugada.", victimOf("ai-purple", "ai-green"))).toEqual({ reason: DIRECTION, detail: "termino=disculpa de quien captura: era la mejor jugada" });
    // Quien captura no puede contar que el rival se ha comido su ficha.
    expect(checkQuality("Abuela Pilar se come mi ficha.", capturer("ai-purple", "ai-green"))).toMatchObject({ reason: DIRECTION });
  });

  it("el propio nombre como destinatario se rechaza para los cuatro; el del rival, no", () => {
    for (const speaker of IDS) {
      const rival = IDS.find((id) => id !== speaker)!;
      const own = NAMES[speaker];
      for (const text of [`Bien jugado, ${own}.`, `${own}, qué suerte la mía.`, `¡Ay, ${own}! Otra vez será.`]) {
        expect(checkQuality(text, capturer(speaker, rival)), `${own}: ${text}`).toMatchObject({ reason: SELF });
      }
      expect(checkQuality(`Bien jugado, ${NAMES[rival]}.`, capturer(speaker, rival)), `${own} → ${NAMES[rival]}`).toBeNull();
    }
    // Alias propios («Ernesto», «Pilar») también; nombrarse sin hablarse a sí mismo no es un vocativo.
    expect(checkQuality("Lo tenía calculado, Ernesto.", capturer("ai-purple", "ai-pink"))).toMatchObject({ reason: SELF, term: "ernesto" });
    expect(checkQuality("Ay, Pilar, qué cosas.", capturer("ai-green", "ai-pink"))).toMatchObject({ reason: SELF, term: "pilar" });
    expect(checkQuality("¡Otra para Chispa!", capturer("ai-blue", "ai-pink"))).toMatchObject({ reason: "se nombra a sí mismo", term: "chispa" });
  });

  it("con capturas anteriores en el otro sentido no se confunde quién comió a quién en esta", () => {
    // Brava le había comido dos veces a Chispa; ahora Chispa le come a Brava.
    const log = [cap(10, "ai-pink", "ai-blue"), cap(20, "ai-pink", "ai-blue"), cap(30, "ai-blue", "ai-pink")];
    expect(reject("¡Te comí, Brava!", capturer("ai-blue", "ai-pink", log))).toBeNull();
    expect(checkQuality("Me comiste antes, pero hoy no, Brava.", capturer("ai-blue", "ai-pink", log))).toMatchObject({ reason: DIRECTION });
    // Y desde el lado de Brava (la víctima de ahora), aunque antes fuera ella quien comía.
    expect(reject("Me comiste, Chispa.", victimOf("ai-pink", "ai-blue", log))).toBeNull();
    expect(checkQuality("Te comí dos veces, Chispa.", victimOf("ai-pink", "ai-blue", log))).toMatchObject({ reason: DIRECTION });
  });

  it("fuera de las capturas no hay dirección que comprobar", () => {
    const goal = say("ai-pink", null, { kind: "goal", trigger: "goal", important: false });
    expect(checkQuality("¡Otra en la meta! Esto marcha.", goal)).toBeNull();
  });

  it("«Sigo aquí, y con ganas.» y «¡Dentro! Y sin pedir permiso.»: fuera del catálogo, rechazadas y sin citarse", () => {
    for (const text of ["Sigo aquí, y con ganas.", "Sigo aquí y con ganas, Chispa.", "¡Dentro! Y sin pedir permiso.", "Una más, sin pedir permiso a nadie.", "¡Dentro, sin pedirle permiso!"]) {
      expect(checkQuality(text, capturer("ai-pink", "ai-blue")), text).toMatchObject({ reason: "expresión poco natural" });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
    expect(reject("Sigo aquí, y con ganas.", capturer("ai-pink", "ai-blue"))).toEqual({ reason: "expresión poco natural", detail: "termino=sigo aquí y con ganas" });
    for (const text of ["Aquí sigo, Chispa.", "Con ganas de la siguiente, Chispa.", "¡Dentro, Chispa!"]) {
      expect(checkQuality(text, capturer("ai-pink", "ai-blue")), text).toBeNull();
    }
    for (const c of CHARACTERS) {
      for (const lines of Object.values(c.chat.lines)) {
        for (const line of lines) expect(line, `${c.name}: ${line}`).not.toMatch(/sigo aquí,? y con ganas|sin pedir permiso/i);
      }
    }
  });

  it("catálogo: ninguna frase local habla a su propio personaje ni cuenta la captura al revés", () => {
    const kindTrigger: Record<string, ChatTrigger> = {
      victory_win: "victory", victory_reply: "victory", capture_boast: "capture", capture_lament: "capture",
      streak_boast: "capture_streak", streak_lament: "bad_streak", third_six_self: "third_six", third_six_tease: "third_six",
      goal: "goal", finish_place: "finish_place", ambient_lead: "ambient", ambient_ahead: "ambient", ambient_behind: "ambient",
    };
    for (const c of CHARACTERS) {
      const rival = IDS.find((id) => id !== c.id)!;
      for (const [kind, lines] of Object.entries(c.chat.lines)) {
        for (const line of lines) {
          const text = line.replaceAll("{rival}", NAMES[rival]).replaceAll("{Count}", "Dos").replaceAll("{count}", "dos").replaceAll("{ritmo}", "seguidas");
          const issue = checkQuality(text, say(c.id, rival, { kind: kind as Utterance["kind"], trigger: kindTrigger[kind] }));
          expect(issue?.reason, `${c.name}/${kind}: ${text}`).not.toBe(SELF);
          expect(issue?.reason, `${c.name}/${kind}: ${text}`).not.toBe(DIRECTION);
        }
      }
    }
  });

  it("los motivos nuevos están en la lista que se registra", () => {
    expect(INVALID_RESPONSE_REASONS).toContain(SELF);
    expect(INVALID_RESPONSE_REASONS).toContain(DIRECTION);
  });
});

describe("disculpas de quien pierde la ficha: solo se rechazan si se atribuye la captura", () => {
  const DIRECTION = "contradice quién captura";
  const victimOf = (speaker: string, by: string, log = [cap(10, by, speaker)]) => say(speaker, by, { kind: "capture_lament", captures: factsOf(log, speaker) });
  const capturer = (speaker: string, victim: string) => say(speaker, victim, { kind: "capture_boast", captures: factsOf([cap(10, speaker, victim)], speaker) });

  it("Abuela Pilar le come a Don Ernesto: «Lo siento, Abuela Pilar. Era la mejor jugada» de Don Ernesto se rechaza y se usa la frase local", () => {
    expect(reject("Lo siento, Abuela Pilar. Era la mejor jugada.", victimOf("ai-purple", "ai-green"))).toMatchObject({ reason: DIRECTION });
    // Otras disculpas que justifican una captura que no ha hecho quien habla.
    for (const text of [
      "Perdona, Brava, no tenía otra opción.",
      "Lo siento, Brava, tenía que hacerlo.",
      "Perdona, Brava. Nada personal.",
      "Lo siento, Brava. No me lo tengas en cuenta.",
      "Disculpa, Brava, estaba a tiro.",
    ]) {
      expect(checkQuality(text, victimOf("ai-blue", "ai-pink")), text).toMatchObject({ reason: DIRECTION });
    }
  });

  it("las disculpas naturales de quien pierde la ficha se aceptan", () => {
    for (const text of ["Perdona, Brava, pero la próxima es mía.", "Lo siento, hoy no hay suerte, Brava.", "Perdona, Brava, ¿me repites la tirada?", "Lo siento por mi ficha, Brava."]) {
      expect(checkQuality(text, victimOf("ai-blue", "ai-pink")), text).toBeNull();
    }
    // Don Ernesto, de usted.
    expect(reject("Disculpe, Abuela Pilar, pero la próxima es mía.", victimOf("ai-purple", "ai-green"))).toBeNull();
  });

  it("la justificación sola es ambigua (puede ser un elogio) y no se rechaza; quien captura puede disculparse y justificarse", () => {
    expect(checkQuality("Era la mejor jugada, Brava. Bien jugado.", victimOf("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("Lo siento, Chispa. Era la mejor jugada.", capturer("ai-pink", "ai-blue"))).toBeNull();
  });

  it("se mira el acontecimiento actual, no el historial: con capturas anteriores del hablante, la disculpa que justifica esta captura sigue rechazada", () => {
    const log = [cap(5, "ai-blue", "ai-pink"), cap(8, "ai-blue", "ai-pink"), cap(10, "ai-pink", "ai-blue")];
    expect(checkQuality("Perdona, Brava, no tenía otra opción.", victimOf("ai-blue", "ai-pink", log))).toMatchObject({ reason: DIRECTION });
    expect(checkQuality("Perdona, Brava, pero la próxima es mía.", victimOf("ai-blue", "ai-pink", log))).toBeNull();
  });
});

describe("partida real: «quitar» fichas, «de libro», distancias a la meta y respuestas que no hablan de la captura", () => {
  const UNNATURAL = "expresión poco natural";
  const OFF_TOPIC = "no responde a la captura";
  const NAMES: Record<string, string> = { "ai-pink": "Brava", "ai-purple": "Don Ernesto", "ai-green": "Abuela Pilar", "ai-blue": "Chispa" };
  const capturer = (speaker: string, victim: string) => say(speaker, victim, { kind: "capture_boast", captures: factsOf([cap(10, speaker, victim)], speaker) });
  const victimOf = (speaker: string, by: string, extra: Partial<Utterance> = {}) =>
    say(speaker, by, { kind: "capture_lament", captures: factsOf([cap(10, by, speaker)], speaker), ...extra });
  const goal = (speaker: string) => say(speaker, null, { kind: "goal", trigger: "goal", important: false });

  it("«Te la he quitado», «Me ha quitado una ficha» y variantes se rechazan; «comer» se acepta", () => {
    expect(reject("Te la he quitado, Abuela Pilar.", capturer("ai-pink", "ai-green"))).toEqual({ reason: UNNATURAL, detail: "termino=quitar una ficha" });
    expect(reject("Me ha quitado una ficha, Abuela Pilar.", victimOf("ai-purple", "ai-green"))).toEqual({ reason: UNNATURAL, detail: "termino=quitar una ficha" });
    for (const text of ["Me han quitado una ficha, Brava.", "Te he quitado la ficha, Chispa.", "¡Te quité esa, Chispa!", "Me quitaste la ficha, Brava."]) {
      expect(checkQuality(text, capturer("ai-pink", "ai-blue"))?.term, text).toBe("quitar una ficha");
    }
    expect(reject("Te he comido, Abuela Pilar.", capturer("ai-pink", "ai-green"))).toBeNull();
    expect(reject("He comido tu ficha, Abuela Pilar.", capturer("ai-pink", "ai-green"))).toBeNull();
    expect(reject("Me has comido una ficha, Brava.", victimOf("ai-blue", "ai-pink"))).toBeNull();
    // Don Ernesto, de usted.
    expect(reject("He comido su ficha, Abuela Pilar.", capturer("ai-purple", "ai-green"))).toBeNull();
    expect(reject("Me ha comido una ficha, Abuela Pilar.", victimOf("ai-purple", "ai-green"))).toBeNull();
  });

  it("«Una captura de libro» y otras frases de comentarista se rechazan", () => {
    expect(reject("Una captura de libro, Abuela Pilar.", capturer("ai-purple", "ai-green"))).toEqual({ reason: UNNATURAL, detail: "termino=de libro" });
    expect(checkQuality("Jugada de manual, Chispa.", capturer("ai-pink", "ai-blue"))?.term).toBe("de libro");
    expect(hasDiscardedExpression("Una captura de libro. Nada personal, Brava.")).toBe(true);
  });

  it("nadie anuncia cuántas casillas le quedan para la meta; celebrar que llega o que está cerca, sí", () => {
    for (const text of ["Y ahora a la meta en seis.", "Me quedan cinco casillas.", "Estoy a tres de la meta.", "A dos casillas de la meta, ya casi.", "Me faltan 4 casillas para entrar.", "Con un seis, a la meta.", "Otro cinco y a la meta."]) {
      expect(checkQuality(text, goal("ai-blue")), text).toEqual({ reason: "afirmación no respaldada", term: "distancia a la meta" });
    }
    for (const text of ["¡Una más en la meta!", "Ya casi estoy en la meta.", "¡Esta ficha está cerquísima de la meta!", "Llegué a la meta."]) {
      expect(checkQuality(text, goal("ai-blue")), text).toBeNull();
    }
  });

  it("caso real: Brava le come a Abuela Pilar y ella responde «Tengo otra en meta, qué suerte» → se rechaza", () => {
    const reply = victimOf("ai-green", "ai-pink", { replyTo: 0 });
    expect(reject("Tengo otra en meta, qué suerte.", reply)).toEqual({ reason: OFF_TOPIC, detail: "termino=meta" });
    // Otros acontecimientos o buena suerte propia, tampoco.
    expect(checkQuality("Ahora saco otra ficha de casa, Brava.", reply)).toEqual({ reason: OFF_TOPIC, term: "sacar ficha" });
    expect(checkQuality("Qué suerte la mía, Brava.", reply)).toEqual({ reason: OFF_TOPIC, term: "buena suerte propia" });
    expect(checkQuality("Estoy de suerte, Brava.", reply)).toEqual({ reason: OFF_TOPIC, term: "buena suerte propia" });
    // Reacciones a la captura, con el carácter de Pilar: sí.
    for (const text of ["Ay, Brava, me has comido una ficha.", "Qué mala suerte, Brava. Paciencia.", "¡Qué suerte tienes, Brava!", "Me has comido, Brava, pero esto no ha acabado."]) {
      expect(reject(text, reply), text).toBeNull();
    }
  });

  it("quien captura tampoco cambia de tema; sí puede celebrar su suerte", () => {
    expect(checkQuality("Te comí, y ya tengo dos en meta, Chispa.", capturer("ai-pink", "ai-blue"))).toEqual({ reason: OFF_TOPIC, term: "meta" });
    expect(checkQuality("¡Qué suerte! Te comí, Chispa.", capturer("ai-pink", "ai-blue"))).toBeNull();
  });

  it("en una captura simple, quien la pierde nombra a quien se la come (nada de «me han comido» impersonal); en una mala racha, sí", () => {
    expect(checkQuality("Me han comido, qué rabia.", victimOf("ai-blue", "ai-pink"))).toEqual({ reason: OFF_TOPIC, term: "me han comido (impersonal)" });
    const badStreak = say("ai-blue", "ai-pink", {
      kind: "streak_lament",
      trigger: "bad_streak",
      captures: factsOf([cap(10, "ai-green", "ai-blue"), cap(20, "ai-pink", "ai-blue")], "ai-blue"),
    });
    expect(checkQuality("¡Me han comido otra vez! Qué día.", badStreak)?.reason).not.toBe(OFF_TOPIC);
  });

  it("fuera de las capturas no se comprueba el tema", () => {
    expect(checkQuality("¡Una más en la meta!", goal("ai-green"))).toBeNull();
  });

  it("catálogo: ninguna frase con «quitar», «de libro» o distancias a la meta, y las de captura hablan de la captura", () => {
    const kindTrigger: Record<string, ChatTrigger> = {
      victory_win: "victory", victory_reply: "victory", capture_boast: "capture", capture_lament: "capture",
      streak_boast: "capture_streak", streak_lament: "bad_streak", third_six_self: "third_six", third_six_tease: "third_six",
      goal: "goal", finish_place: "finish_place", ambient_lead: "ambient", ambient_ahead: "ambient", ambient_behind: "ambient",
    };
    for (const c of CHARACTERS) {
      const rival = Object.keys(NAMES).find((id) => id !== c.id)!;
      for (const [kind, lines] of Object.entries(c.chat.lines)) {
        for (const line of lines) {
          expect(line, `${c.name}: ${line}`).not.toMatch(/de libro|de manual/i);
          const text = line.replaceAll("{rival}", NAMES[rival]).replaceAll("{Count}", "Dos").replaceAll("{count}", "dos").replaceAll("{ritmo}", "seguidas");
          const issue = checkQuality(text, say(c.id, rival, { kind: kind as Utterance["kind"], trigger: kindTrigger[kind] }));
          expect(issue?.term, `${c.name}/${kind}: ${text}`).not.toBe("distancia a la meta");
          expect(issue?.term, `${c.name}/${kind}: ${text}`).not.toBe("quitar una ficha");
          expect(issue?.reason, `${c.name}/${kind}: ${text}`).not.toBe(OFF_TOPIC);
        }
      }
    }
    expect(CHARACTERS.find((c) => c.id === "ai-purple")!.chat.lines.capture_boast).toContain("He comido su ficha, {rival}. Nada personal.");
    expect(CHARACTERS.find((c) => c.id === "ai-blue")!.chat.lines.capture_lament).toContain("¡Me has comido, {rival}! Qué rabia.");
  });

  it("el motivo nuevo está en la lista que se registra", () => {
    expect(INVALID_RESPONSE_REASONS).toContain(OFF_TOPIC);
  });
});

describe("Abuela Pilar al grupo («hijos», no «cariños»), la frase retirada de Chispa y «Ni la suerte me acompaña»", () => {
  const UNNATURAL = "expresión poco natural";
  const PILAR = "ai-green";
  const pilarLines = () => Object.values(CHARACTERS.find((c) => c.id === PILAR)!.chat.lines).flat();

  it("Pilar dice «hijos» al grupo en el catálogo, y el LLM no puede usar «cariños»", () => {
    const lines = pilarLines();
    expect(lines).toContain("Gané, hijos. Poquito a poco, pero gané.");
    expect(lines).toContain("¿Pero qué os he hecho yo, hijos? Ya van {count}.");
    expect(lines).toContain("La abuela va ganando. Tomad nota, hijos.");
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toMatch(/cariños/i);
    const ambient = say(PILAR, null, { kind: "ambient_lead", trigger: "ambient", important: false });
    expect(checkQuality("Tomad nota, cariños.", ambient)).toEqual({ reason: UNNATURAL, term: "cariños" });
    expect(checkQuality("Tomad nota, hijos.", ambient)).toBeNull();
    expect(hasDiscardedExpression("La abuela va ganando. Tomad nota, cariños.")).toBe(true);
  });

  it("a un solo rival, «cariño» sigue valiendo", () => {
    const capturer = say(PILAR, "ai-blue", { kind: "capture_boast", captures: factsOf([cap(10, PILAR, "ai-blue")], PILAR) });
    expect(reject("Ay, cariño, te he comido, Chispa.", capturer)).toBeNull();
  });

  it("«¡Ay, pobre Abuela! Se le escapa la captura.» no está en el catálogo, no se acepta del LLM y no se cita", () => {
    const text = "¡Ay, pobre Abuela! Se le escapa la captura.";
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toMatch(/pobre abuela|se le escapa la captura/i);
    const chispa = say("ai-blue", PILAR, { kind: "ambient_ahead", trigger: "ambient", important: false });
    expect(checkQuality(text, chispa)).toMatchObject({ reason: UNNATURAL });
    expect(checkQuality("¡Pobre Abuela, Abuela Pilar!", chispa)).toEqual({ reason: UNNATURAL, term: "pobre abuela" });
    expect(checkQuality("Se te ha escapado la captura, Abuela Pilar.", chispa)).toEqual({ reason: UNNATURAL, term: "se le escapa la captura" });
    expect(hasDiscardedExpression(text)).toBe(true);
  });

  it("«¡Jo! Ni la suerte me acompaña.» sustituye a «me aguanta» (es una frase de Brava, en el tercer seis)", () => {
    expect(CHARACTERS.find((c) => c.id === "ai-pink")!.chat.lines.third_six_self).toContain("¡Jo! Ni la suerte me acompaña.");
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toBe("¡Jo! Ni la suerte me aguanta.");
  });
});

describe("coletilla «y ya vas dos» (partida real de Brava)", () => {
  const capturer = say("ai-pink", "ai-blue", { kind: "capture_boast", captures: factsOf([cap(10, "ai-pink", "ai-blue"), cap(20, "ai-pink", "ai-blue")], "ai-pink") });

  it("«He comido tu ficha y ya vas dos.» se rechaza (aunque la cifra fuera cierta) y no se cita; sin la coletilla, se acepta", () => {
    expect(reject("He comido tu ficha y ya vas dos.", capturer)).toEqual({ reason: "expresión poco natural", detail: "termino=ya vas dos" });
    for (const text of ["Te comí, Chispa, y ya vais tres.", "Ya vas por la segunda, Chispa.", "Te he comido. Vas dos, Chispa.", "Y ya vas 2, Chispa."]) {
      expect(checkQuality(text, capturer)?.term, text).toBe("ya vas dos");
    }
    expect(hasDiscardedExpression("He comido tu ficha y ya vas dos.")).toBe(true);
    expect(reject("He comido tu ficha, Chispa.", capturer)).toBeNull();
    expect(reject("Te comí, Chispa.", capturer)).toBeNull();
  });

  it("no se confunde con otros usos de «vas»", () => {
    for (const text of ["Vas una casilla por delante, Chispa.", "¿Adónde vas, Chispa?", "Vas a ver, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue", { kind: "ambient_ahead", trigger: "ambient", important: false }))?.term, text).not.toBe("ya vas dos");
    }
  });

  it("no está en el catálogo local", () => {
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toMatch(/\bva(s|is)\s+(ya\s+)?(\{count\}|dos|tres|cuatro|\d)/i);
  });
});

describe("«Sigo en la pelea» y «Mantengo la ventaja», retiradas", () => {
  const ambient = (speaker: string, kind: Utterance["kind"]) => say(speaker, null, { kind, trigger: "ambient", important: false });
  const UNNATURAL = "expresión poco natural";

  it("se rechazan, con sus variantes, y no se citan en el contexto", () => {
    for (const text of ["Sigo en la pelea. Ojo conmigo.", "Sigo dando pelea, que conste.", "Seguimos en la pelea.", "Aún doy pelea."]) {
      expect(checkQuality(text, ambient("ai-pink", "ambient_ahead")), text).toEqual({ reason: UNNATURAL, term: "sigo en la pelea" });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
    for (const text of ["Mantengo la ventaja. Paciencia y método.", "Mantengo mi ventaja.", "Conservo la ventaja, como era de esperar.", "Sigo manteniendo la ventaja."]) {
      expect(checkQuality(text, ambient("ai-purple", "ambient_lead")), text).toEqual({ reason: UNNATURAL, term: "mantengo la ventaja" });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("no bloquea usos naturales de «pelea», «ventaja» o «mantener»", () => {
    for (const [speaker, kind, text] of [
      ["ai-pink", "ambient_ahead", "¡Aquí no se rinde nadie! Y yo, menos."],
      ["ai-blue", "ambient_ahead", "¡Qué pelea más igualada!"],
      ["ai-purple", "ambient_behind", "Una desventaja temporal. Nada que un buen plan no corrija."],
      ["ai-purple", "ambient_ahead", "Abuela Pilar, no confunda ventaja con victoria."],
      ["ai-green", "ambient_ahead", "Hay que mantener la calma, hijos."],
      ["ai-blue", "ambient_ahead", "Brava lleva ventaja, pero esto no ha acabado."],
    ] as const) {
      expect(checkQuality(text, ambient(speaker, kind)), text).toBeNull();
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("no están en el catálogo local; las sustitutas sí", () => {
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toMatch(/sigo en la pelea|mantengo la ventaja/i);
    expect(CHARACTERS.find((c) => c.id === "ai-pink")!.chat.lines.ambient_ahead).toContain("Al primero que se me ponga a tiro, lo mando a casa.");
    expect(CHARACTERS.find((c) => c.id === "ai-purple")!.chat.lines.ambient_lead).toContain("Las cuentas me salen, de momento.");
  });
});

describe("frases retiradas definitivamente del chat (catálogo local y LLM)", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const retired = (term: string) => ({ reason: "expresión poco natural", detail: `termino=${term}` });
  /** Las nueve frases, tal como se vieron, en una intervención que el LLM sí escribe (capturas y rachas). */
  const SEEN: [string, string, string, Partial<Utterance>, string][] = [
    ["¿Te comes a la abuela, Don Ernesto? Qué poca vergüenza.", PILAR, ERNESTO, { kind: "capture_lament" }, "te comes a la abuela"],
    ["¡Ya tengo cuatro!", BRAVA, CHISPA, {}, "ya tengo cuatro"],
    ["He sacado un seis, me comiste una ficha.", CHISPA, BRAVA, { kind: "capture_lament" }, "he sacado un seis, me comiste"],
    ["Me has comido, Brava, pero el dado me debe una.", CHISPA, BRAVA, { kind: "capture_lament" }, "el dado me debe una"],
    ["¡Vaya, se me fue la ficha!", CHISPA, BRAVA, { kind: "capture_lament" }, "se me fue la ficha"],
    ["Chispa, desde aquí arriba casi no te veo.", BRAVA, CHISPA, {}, "desde aquí arriba"],
    ["Me has comido, pero sigo en la pelea.", BRAVA, CHISPA, { kind: "capture_lament" }, "sigo en la pelea"],
    ["¡Uy, Brava! Eso no se ve todos los días.", CHISPA, BRAVA, {}, "no se ve todos los días"],
  ];
  /** Una racha real de Brava (tres capturas seguidas a Chispa): «racha» está respaldada, «racha intacta» no se dice. */
  const realStreak = () =>
    say(BRAVA, CHISPA, {
      kind: "streak_boast",
      trigger: "capture_streak",
      streak: { count: 3, consecutive: true },
      captures: factsOf([cap(10, BRAVA, CHISPA), cap(20, BRAVA, CHISPA), cap(30, BRAVA, CHISPA)], BRAVA),
    });

  it("el validador rechaza cada una, por el flujo completo del escritor LLM, con su término", () => {
    for (const [text, speaker, rival, extra, term] of SEEN) expect(reject(text, say(speaker, rival, extra)), text).toEqual(retired(term));
    // «Racha intacta» con una racha real: «racha» está respaldada, pero la frase sigue retirada.
    expect(reject("¡Racha intacta, Chispa!", realStreak())).toEqual(retired("racha intacta"));
    expect(reject("Mi racha sigue, Chispa.", realStreak())).toBeNull();
  });

  it("también las variantes claramente equivalentes, y ninguna se cita en el contexto", () => {
    for (const text of [
      "¿Os coméis a la abuela?", "Te comiste a la abuela, Brava.", "¡Ya tengo las cuatro!",
      "He sacado un seis y me has comido una ficha.", "Este dado me la debe.", "Se me ha ido la ficha.", "Se me escapó la ficha, Brava.",
      "Mi racha sigue intacta, Brava.", "Desde aquí arriba se ve todo.", "Casi no te veo, Chispa.", "Seguimos en la pelea.", "Eso no se ve cada día.",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("no bloquea las palabras sueltas ni las expresiones válidas parecidas", () => {
    for (const [text, speaker, rival, extra] of [
      ["He sacado un seis. ¡Vamos!", BRAVA, CHISPA, {}],
      ["Me comiste, Brava. Ya te pillaré.", CHISPA, BRAVA, { kind: "capture_lament" }],
      ["Ay, Chispa, me has comido la ficha.", PILAR, CHISPA, { kind: "capture_lament" }],
      ["Lo siento, Chispa. Quien se pone a tiro…", PILAR, CHISPA, {}],
      ["He comido su ficha, Brava. Nada personal.", ERNESTO, BRAVA, {}],
      ["¡Te pillé, Brava! A empezar de nuevo.", CHISPA, BRAVA, {}],
    ] as const) expect(reject(text, say(speaker, rival, extra)), text).toBeNull();
    for (const text of ["La abuela también sabe.", "Hoy me salen las tiradas.", "Bah, ha tenido suerte con el dado.", "Esa ficha se fue a casa.", "Te veo muy lejos, Brava.", "Tengo cuatro fichas fuera de casa."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("ninguna está en el catálogo local (con cualquier rival); las sustitutas, sí", () => {
    const RETIRED = /comes a la abuela|ya tengo (las )?cuatro|he sacado un seis.*me comiste|dado me (la )?debe|se me fue la ficha|racha intacta|desde aquí arriba|casi no te veo|sigo en la pelea|no se ve todos los días/i;
    for (const c of CHARACTERS) {
      for (const line of Object.values(c.chat.lines).flat()) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name).replaceAll("{count}", "dos").replaceAll("{Count}", "Dos").replaceAll("{ritmo}", "seguidas");
          expect(text, `${c.name}: ${line}`).not.toMatch(RETIRED);
          expect(hasDiscardedExpression(text), `${c.name}: ${line}`).toBe(false);
        }
      }
    }
    const lines = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines;
    expect(lines(PILAR).capture_lament).toContain("Vaya, {rival}, me has pillado. Ya me tocará a mí.");
    expect(lines(CHISPA).third_six_tease).toContain("¡Ay, {rival}! Ya no tiras más.");
    expect(lines(CHISPA).ambient_lead).toContain("¡Mira, {rival}, voy ganando!");
    expect(lines(CHISPA).ambient_behind).toContain("Voy perdiendo, pero aún quedan muchas tiradas.");
  });

  it("el prompt no las sugiere ni las cita, aunque estén en los textos recientes de una partida antigua", () => {
    const recent = [
      { speaker: CHISPA, text: "Voy perdiendo, pero el dado me debe una." },
      { speaker: PILAR, text: "¿Te comes a la abuela, Chispa? Qué poca vergüenza." },
      { speaker: BRAVA, text: "Chispa, desde aquí arriba casi no te veo." },
    ];
    const [system, user] = buildChatPrompt({ ...say(CHISPA, BRAVA, { kind: "capture_lament" }), recent });
    const all = `${system.content}\n${user.content}`;
    expect(all).not.toContain("he sacado un seis");
    for (const bad of ["me debe una", "comes a la abuela", "aquí arriba", "no te veo", "ya tengo cuatro", "se me fue la ficha", "racha intacta", "sigo en la pelea", "todos los días"]) {
      expect(all.toLowerCase(), bad).not.toContain(bad);
    }
  });
});

describe("«Tengo que sacar otro seis» y equivalentes, retirados", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const retired = { reason: "expresión poco natural", detail: "termino=necesito un seis" };

  it("se rechazan por el flujo completo del escritor LLM (los ejemplos pedidos y variantes equivalentes)", () => {
    for (const text of ["Necesito un seis.", "Me hace falta otro seis.", "Tengo que sacar otro seis.", "Tengo que volver a sacar seis."]) {
      expect(reject(text, say(CHISPA, BRAVA, { kind: "capture_lament" })), text).toEqual(retired);
      expect(reject(text, say(BRAVA, CHISPA)), text).toEqual(retired);
    }
    for (const text of [
      "¡Necesito otro seis ya!", "Me hacen falta dos seises.", "Nos hace falta un seis.", "Tendré que sacar un seis.", "He de sacar otro seis.",
      "Necesito sacar un seis, Brava.", "Me falta un seis para alcanzarte.", "Hace falta que salga un seis.", "Esto se arregla con un par de seises.", "Necesitaría un seis.",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("no prohíbe hablar de un seis que acaba de salir ni la palabra «seis»", () => {
    for (const [text, speaker, rival, extra] of [
      ["He sacado un seis. ¡Vamos!", BRAVA, CHISPA, {}],
      ["¡Otro seis! Y encima te pillo, Chispa.", BRAVA, CHISPA, {}],
      ["Me ha salido un seis y le he comido, Brava.", ERNESTO, BRAVA, {}],
      ["Con ese seis me has comido, Chispa. Paciencia.", PILAR, CHISPA, { kind: "capture_lament" }],
    ] as const) expect(reject(text, say(speaker, rival, extra)), text).toBeNull();
    for (const text of ["¡Seis! Qué alegría.", "Tres seises, Brava. Te quedas sin turno.", "A ver si sale un seis.", "Necesito calma.", "Tengo que sacar ficha de casa.", "Seis, seis, seis… y castigo."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("no está en el catálogo local con ningún rival (la frase de Chispa que pedía seises se sustituye) ni en el prompt", () => {
    for (const c of CHARACTERS) {
      for (const line of Object.values(c.chat.lines).flat()) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name).replaceAll("{count}", "dos").replaceAll("{Count}", "Dos").replaceAll("{ritmo}", "seguidas");
          expect(hasDiscardedExpression(text), `${c.name}: ${line}`).toBe(false);
        }
      }
    }
    const behind = CHARACTERS.find((c) => c.id === CHISPA)!.chat.lines.ambient_behind;
    expect(behind).not.toContain("Esto se arregla con un par de seises. Ni uno más.");
    expect(behind).toContain("Todavía puedo alcanzaros.");
    const [system, user] = buildChatPrompt({ ...say(CHISPA, BRAVA, { kind: "capture_lament" }), recent: [{ speaker: CHISPA, text: "Tengo que sacar otro seis." }] });
    expect(`${system.content}\n${user.content}`).not.toMatch(/sacar otro seis|necesito un seis|hace falta otro seis/i);
  });
});

describe("«Que no cunda el pánico» y equivalentes, retirados", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const retired = { reason: "expresión poco natural", detail: "termino=que no cunda el pánico" };

  it("se rechazan por el flujo completo del escritor LLM, con sus variantes", () => {
    for (const text of ["Que no cunda el pánico.", "No cunda el pánico.", "Que no cunda el pánico, Brava.", "Tranquilos, que no hay que entrar en pánico.", "No hay motivo para alarmarse."]) {
      expect(reject(text, say(CHISPA, BRAVA, { kind: "capture_lament" })), text).toEqual(retired);
    }
    expect(reject("Me has comido, Chispa, pero que no cunda el pánico.", say(PILAR, CHISPA, { kind: "capture_lament" }))).toEqual(retired);
    for (const text of ["Esto da muchas vueltas. Que no cunda el pánico.", "No entremos en pánico.", "Nada de pánico, Chispa.", "Sin pánico, que queda partida.", "No hay motivos para alarmarnos, hijos.", "No os alarméis.", "Que nadie se alarme."]) {
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("otras expresiones de los personajes se siguen aceptando", () => {
    for (const [text, speaker, rival, extra] of [
      ["¡Qué susto! Me has comido, Brava.", CHISPA, BRAVA, { kind: "capture_lament" }],
      ["Tranquila, Abuela Pilar, que aún queda partida.", BRAVA, PILAR, { kind: "capture_lament" }],
      ["He comido su ficha, Brava. Nada personal.", ERNESTO, BRAVA, {}],
      ["¡Te pillé, Brava! A empezar de nuevo.", CHISPA, BRAVA, {}],
    ] as const) expect(reject(text, say(speaker, rival, extra)), text).toBeNull();
    for (const text of ["¡Qué pánico me da esa ficha tuya, Brava!", "Todavía puedo alcanzaros.", "¡Que no decaiga! Brava, te estoy vigilando.", "Hay motivos para celebrarlo.", "La alarma ha sonado, Chispa."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("no está en el catálogo local con ningún rival; la frase de Chispa se sustituye", () => {
    for (const c of CHARACTERS) {
      for (const line of Object.values(c.chat.lines).flat()) {
        expect(line, `${c.name}: ${line}`).not.toMatch(/p[aá]nico|alarm/i);
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name).replaceAll("{count}", "dos").replaceAll("{Count}", "Dos").replaceAll("{ritmo}", "seguidas");
          expect(hasDiscardedExpression(text), `${c.name}: ${line}`).toBe(false);
        }
      }
    }
    const behind = CHARACTERS.find((c) => c.id === CHISPA)!.chat.lines.ambient_behind;
    expect(behind).not.toContain("Esto da muchas vueltas. Que no cunda el pánico.");
    expect(behind).toContain("Todavía puedo alcanzaros.");
  });
});

describe("norma de lenguaje: amuletos, dado con vida propia y soplar al dado, retirados", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });

  it("las tres expresiones se rechazan por el flujo completo del escritor LLM", () => {
    // Con Chispa realmente en cabeza («voy ganando» respaldado): lo que se rechaza es el amuleto.
    expect(checkQuality("¡Mira, Brava, voy ganando!", { ...say(CHISPA, BRAVA), leader: CHISPA })).toBeNull();
    expect(checkQuality("¡Mira, Brava, voy ganando! Será el amuleto.", { ...say(CHISPA, BRAVA), leader: CHISPA })).toEqual({ reason: "expresión poco natural", term: "será el amuleto" });
    expect(reject("¡Ay, Brava! El dado te ha mirado mal.", say(CHISPA, BRAVA))).toEqual(term("personificación del dado"));
    expect(reject("Me has comido. Le soplo al dado, a ver si cambia la cosa.", say(CHISPA, BRAVA, { kind: "capture_lament" }))).toEqual(term("soplar al dado"));
  });

  it("también sus variantes equivalentes y el resto del dado con vida propia o las supersticiones gratuitas", () => {
    for (const [text, t] of [
      ["Será el amuleto.", "será el amuleto"], ["Hoy es mi día. O eso dice mi amuleto.", "será el amuleto"], ["Gracias al amuleto, Brava.", "será el amuleto"],
      ["Me he dejado el amuleto en casa.", "será el amuleto"], ["Mi amuleto no falla.", "será el amuleto"],
      ["El dado me ha mirado mal.", "personificación del dado"], ["Hoy el dado me quiere.", "personificación del dado"], ["Ni el dado te quiere, Brava.", "personificación del dado"],
      ["El dado está de mi parte.", "personificación del dado"], ["El dado se ha venido arriba.", "personificación del dado"], ["¡Toma ya! El dado lo ha querido así.", "personificación del dado"],
      ["¡Y el dado dice… a casa, Brava!", "personificación del dado"], ["Le debo una al dado.", "personificación del dado"], ["Hasta el dado quiere pelea.", "personificación del dado"],
      ["El dado me castiga.", "personificación del dado"], ["El dado no perdona.", "personificación del dado"],
      ["Voy a soplar al dado.", "soplar al dado"], ["Lo decía el horóscopo.", "superstición"], ["Llevaba los calcetines de la suerte.", "superstición"], ["Me han echado mal de ojo.", "superstición"],
    ] as const) {
      expect(checkQuality(text, say(CHISPA, BRAVA, { kind: "capture_lament" })), text).toEqual({ reason: "expresión poco natural", term: t });
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("no prohíbe «dado», «seis», «suerte» ni frases naturales sobre ellos", () => {
    for (const [text, speaker, rival, extra] of [
      ["He sacado un seis. ¡Vamos!", BRAVA, CHISPA, {}],
      ["¡Qué mala pata! Me has comido, Brava.", CHISPA, BRAVA, { kind: "capture_lament" }],
      ["Que no se me vaya la suerte. ¡A casa, Brava!", CHISPA, BRAVA, {}],
      ["Le he comido, Brava. Era de esperar.", ERNESTO, BRAVA, { captures: factsOf([cap(10, ERNESTO, BRAVA)], ERNESTO) }],
      ["Ay, Chispa, me has comido la ficha.", PILAR, CHISPA, { kind: "capture_lament" }],
    ] as const) expect(reject(text, say(speaker, rival, extra)), text).toBeNull();
    for (const text of [
      "Bah, Brava ha tenido suerte con el dado.", "El dado ha caído en cinco.", "Toco madera.", "Me has dado un susto, Brava.", "Te has dado prisa, Chispa.",
      "Dado que vas primera, te vigilo.", "Esto ya no es azar, Brava.", "Ya decía yo que tanta suerte no era normal.", "¿Otra vez? Esto ya es gafe, Brava.", "Hoy me sale todo.",
    ]) expect(hasDiscardedExpression(text), text).toBe(false);
  });

  it("el catálogo cumple la norma: ninguna frase con el dado con vida propia, amuletos o supersticiones gratuitas", () => {
    for (const c of CHARACTERS) {
      for (const line of Object.values(c.chat.lines).flat()) {
        expect(line, `${c.name}: ${line}`).not.toMatch(/amuleto|horóscopo|calcetines|mal de ojo|sopl/i);
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name).replaceAll("{count}", "dos").replaceAll("{Count}", "Dos").replaceAll("{ritmo}", "seguidas");
          expect(hasDiscardedExpression(text), `${c.name}: ${line}`).toBe(false);
        }
      }
    }
    const lines = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines;
    expect(lines(CHISPA).ambient_lead).toContain("¡Mira, {rival}, voy ganando!");
    expect(lines(CHISPA).third_six_tease).toContain("¡Ay, {rival}! Ya no tiras más.");
    expect(lines(CHISPA).ambient_behind).toContain("Todavía puedo alcanzaros.");
  });

  it("el prompt pide una sola idea y no da vida al dado, sin nombrar lo prohibido", () => {
    const [system, user] = buildChatPrompt({ ...say(CHISPA, BRAVA, { kind: "capture_lament" }), recent: [{ speaker: CHISPA, text: "¡Mira, Brava, voy ganando! Será el amuleto." }] });
    expect(system.content).toContain("Una sola frase corta en español, con una sola idea:");
    expect(system.content).toContain("El dado es solo un dado.");
    expect(`${system.content}\n${user.content}`).not.toMatch(/amuleto|horóscopo|mal de ojo|sopl/i);
  });
});

describe("revisión de coletillas: retiradas las artificiales y la disculpa de broma", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const retired = { reason: "expresión poco natural", detail: "termino=coletilla retirada" };
  const joke = { reason: "expresión poco natural", detail: "termino=disculpa de broma" };

  it("las coletillas retiradas se rechazan por el flujo completo del escritor LLM", () => {
    expect(reject("Victoria. Todo según lo previsto.", say(ERNESTO, null, { kind: "victory_win", trigger: "victory" }))).toEqual(retired);
    expect(reject("Todo según el plan, Brava.", say(ERNESTO, BRAVA))).toEqual(retired);
    expect(reject("Estadísticamente era inevitable.", say(ERNESTO, BRAVA))).toEqual(retired);
    expect(reject("Quien ríe el último ríe mejor, Chispa.", say(PILAR, CHISPA))).toEqual(retired);
    expect(reject("¿Quién es el siguiente? ¡A casa, Chispa!", say(BRAVA, CHISPA))).toEqual(retired);
  });

  it("la disculpa de broma se rechaza; una disculpa normal, no", () => {
    for (const text of ["Abuela Pilar, a casa. Lo siento… un poco.", "¡Uy, perdón, Abuela Pilar! Bueno, perdón no mucho.", "Lo siento, Abuela Pilar… no mucho."]) {
      expect(reject(text, say(CHISPA, PILAR)), text).toEqual(joke);
    }
    for (const text of ["Lo siento, Abuela Pilar. Te he comido.", "¡Uy, perdón, Abuela Pilar!"]) expect(reject(text, say(CHISPA, PILAR)), text).toBeNull();
  });

  it("el registro de coletillas solo tiene expresiones naturales que el personaje usa", () => {
    const phrases = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.catchphrases]));
    expect(phrases).toEqual({
      [BRAVA]: ["¡A casa!", "Voy a por ti", "Eso no ha sido nada"],
      [ERNESTO]: ["Previsible", "Lo tenía calculado", "Era de esperar"],
      [PILAR]: ["Despacito y buena letra", "Ay, hijo, qué prisas", "Sin prisa"],
      [CHISPA]: ["¡Qué mala pata!", "Hoy es mi día", "¡Toma ya!"],
    });
    for (const c of CHARACTERS) for (const phrase of c.catchphrases) expect(hasDiscardedExpression(phrase), `${c.name}: ${phrase}`).toBe(false);
  });

  it("el catálogo no tiene coletillas retiradas, bromas de disculpa ni expresiones exageradas", () => {
    const EXAGGERATED = /todo según lo previsto|todo según el plan|estadísticamente era inevitable|quien ríe el último|quién es el siguiente|ni me he despeinado|imparable|que alguien me pare|de caza|pim, pam|a toda máquina|misión cumplida|con estilo|tan ancha|chocolate|merienda|más tiempo en casa que en el tablero|gafe|un poco\.|no mucho\.|no tanta|perdón no mucho/i;
    for (const c of CHARACTERS) for (const line of Object.values(c.chat.lines).flat()) expect(line, `${c.name}: ${line}`).not.toMatch(EXAGGERATED);
    // «Despacito y buena letra» y «Hoy es mi día» quedan una sola vez cada una.
    const count = (id: string, re: RegExp) => Object.values(CHARACTERS.find((c) => c.id === id)!.chat.lines).flat().filter((l) => re.test(l)).length;
    expect(count(PILAR, /despacito y buena letra/i)).toBe(1);
    expect(count(CHISPA, /hoy es mi día/i)).toBe(1);
  });

  it("el carácter de Chispa para el LLM es espontáneo e imprevisible, sin superstición, suerte ni dado", () => {
    const voice = CHARACTERS.find((c) => c.id === CHISPA)!.chat.voice;
    expect(voice).toMatch(/espontáneo/i);
    expect(voice).toMatch(/imprevisible/i);
    expect(voice).not.toMatch(/supersti|dado|suerte|amuleto|humor|travieso|divertido/i);
  });
});

describe("refranes retirados: «La avaricia rompe el saco» y «Quien mucho corre pronto para»", () => {
  const [PILAR, CHISPA] = ["ai-green", "ai-blue"];
  const retired = { reason: "expresión poco natural", detail: "termino=coletilla retirada" };

  it("se rechazan por el flujo completo del escritor LLM, con sus variantes", () => {
    expect(reject("Tres seises… Ay, la avaricia rompe el saco.", say(PILAR, null, { kind: "third_six_self", trigger: "third_six" }))).toEqual(retired);
    expect(reject("Chispa, cariño, quien mucho corre pronto para.", say(PILAR, CHISPA, { kind: "third_six_tease", trigger: "third_six" }))).toEqual(retired);
    for (const text of ["La avaricia rompe el saco, Chispa.", "Avaricia rompe el saco.", "Quien mucho corre, pronto para.", "Ya se sabe: quien mucho corre…"]) {
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("las frases sencillas que los sustituyen y los demás refranes oportunos siguen valiendo", () => {
    for (const text of ["Tres seises… Ay, qué pena.", "Chispa, cariño, pierdes el turno.", "No hay mal que por bien no venga.", "Despacito y buena letra.", "Corre mucho, Chispa."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
    const lines = CHARACTERS.find((c) => c.id === PILAR)!.chat.lines;
    expect(lines.third_six_self).toContain("Tres seises… Ay, qué pena.");
    expect(lines.third_six_tease).toContain("{rival}, cariño, pierdes el turno.");
  });

  it("no quedan en el catálogo, el registro de coletillas ni el carácter de ningún personaje", () => {
    for (const c of CHARACTERS) {
      for (const text of [...Object.values(c.chat.lines).flat(), ...c.catchphrases, c.chat.voice]) expect(text, c.name).not.toMatch(/avaricia|quien mucho corre|pronto para/i);
    }
  });
});

describe("expresiones retiradas tras la prueba real en Preview", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });

  it("cada una se rechaza por el flujo completo del escritor LLM", () => {
    expect(checkQuality("Abuela Pilar, la distancia ya es considerable.", { ...say(ERNESTO, PILAR, { kind: "ambient_lead", trigger: "ambient", important: false }), leader: ERNESTO })).toEqual({ reason: "expresión poco natural", term: "distancia considerable" });
    expect(reject("Abuela Pilar, la distancia ya es considerable.", say(ERNESTO, PILAR))).toEqual(term("distancia considerable"));
    expect(reject("Chispa, a la abuela se la respeta.", say(PILAR, CHISPA, { kind: "capture_lament" }))).toEqual(term("a la abuela se la respeta"));
    expect(reject("Bien hecho, Chispa. Pero no te lo creas mucho, ¿eh?", say(PILAR, CHISPA, { kind: "victory_reply", trigger: "victory" }))).toEqual(term("¿eh?"));
    expect(reject("Me he quedado con la ficha perdida, Brava.", say(CHISPA, BRAVA, { kind: "capture_lament" }))).toEqual(term("ficha perdida"));
    expect(reject("¡Ahora sí que te quedas atrás, Chispa!", say(BRAVA, CHISPA))).toEqual(term("te quedas atrás"));
    expect(reject("¡Qué mal te lo pasas, Chispa!", say(BRAVA, CHISPA))).toEqual(term("qué mal te lo pasas"));
    expect(reject("Me he quedado sin ficha, Brava.", say(CHISPA, BRAVA, { kind: "capture_lament" }))).toEqual(term("me he quedado sin ficha"));
  });

  it("también sus variantes equivalentes, que tampoco se citan en el prompt", () => {
    for (const text of [
      "La distancia es considerable, Chispa.", "Hay una considerable distancia.", "A la abuela se le respeta, Brava.", "Hay que respetar a la abuela.",
      "Muy bien, eh?", "¿Eh?", "Me quedo con la ficha perdida.", "Ya te quedas atrás.", "Te quedas atrás, Brava.", "Que mal te lo pasas.",
      "Lo estás pasando fatal, Chispa.", "Me quedo sin fichas, Brava.", "Me he quedado sin mi ficha.",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("las frases naturales parecidas siguen valiendo", () => {
    for (const text of [
      "Voy ganando. Así me gusta.", "Brava, le saco ventaja. Debería reaccionar.", "Bien hecho, Brava. Pero no te lo creas mucho.", "Me has comido, Brava. Qué le vamos a hacer.",
      "¡Eh, Brava, que te veo!", "Brava, ¿te espero? Te has quedado muy atrás.", "Brava, cariño, no te quedes atrás.", "La abuela también sabe.", "Me he quedado sin turno.", "Lo he pasado bien.",
    ]) expect(hasDiscardedExpression(text), text).toBe(false);
  });

  it("el catálogo no las contiene; «Voy delante» pasa a «Voy ganando» y las sustitutas están en su sitio", () => {
    const RETIRED = /distancia (ya )?es considerable|abuela se la respeta|¿eh\?|ficha perdida|te quedas atrás|mal te lo pasas|quedado sin ficha|voy delante/i;
    for (const c of CHARACTERS) for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases, c.chat.voice]) expect(line, `${c.name}: ${line}`).not.toMatch(RETIRED);
    const lines = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines;
    expect(lines(BRAVA).ambient_lead).toContain("Voy ganando. Así me gusta.");
    expect(lines(ERNESTO).ambient_lead).toContain("{rival}, le saco ventaja. Debería reaccionar.");
    expect(lines(PILAR).victory_reply).toContain("Bien hecho, {rival}. Pero no te lo creas mucho.");
    expect(lines(PILAR).capture_lament).toContain("Me has comido, {rival}. Qué le vamos a hacer.");
  });

  it("la demostración no contiene ninguna", async () => {
    const { createDemoMatch } = await import("@/lib/board/demo");
    const match = await createDemoMatch();
    for (const m of match.messages) expect(hasDiscardedExpression(m.text), m.text).toBe(false);
  });
});

describe("revisión de lenguaje: presentarse, «tener» o «quedarse con» la ficha, «Bien visto» y «Voy delante»", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });
  const OWN = "se nombra a sí mismo";
  /** Nombres propios de cada personaje («la abuela» no es el nombre de Pilar). */
  const OWN_NAMES: Record<string, RegExp> = {
    [BRAVA]: /(?<!\p{L})Brava(?!\p{L})/u,
    [ERNESTO]: /(?<!\p{L})ernesto(?!\p{L})/iu,
    [PILAR]: /(?<!\p{L})pilar(?!\p{L})/iu,
    [CHISPA]: /(?<!\p{L})Chispa(?!\p{L})/u,
  };
  const lead = (speaker: string, rival: string) => ({ ...say(speaker, rival, { kind: "ambient_lead", trigger: "ambient", important: false }), leader: speaker });

  it("cada expresión se rechaza por el flujo completo del escritor LLM, también las que ya estaban retiradas", () => {
    // Las nuevas.
    expect(reject("Soy Don Ernesto y le he comido la ficha a Abuela Pilar.", say(ERNESTO, PILAR))).toEqual({ reason: OWN, detail: "termino=don ernesto" });
    expect(reject("Tengo la tuya, Chispa.", say(BRAVA, CHISPA))).toEqual(term("tener la ficha"));
    expect(reject("Me he quedado con la tuya, Chispa.", say(BRAVA, CHISPA))).toEqual(term("quedarse con la ficha"));
    expect(reject("Bien visto, Brava.", say(CHISPA, BRAVA, { kind: "capture_lament" }))).toEqual(term("bien visto"));
    expect(checkQuality("Voy delante, Chispa.", lead(BRAVA, CHISPA))).toEqual({ reason: "afirmación no respaldada", term: "voy delante" });
    expect(checkQuality("Voy por delante, Chispa.", lead(BRAVA, CHISPA))).toMatchObject({ reason: "afirmación no respaldada" });
    // «Voy ganando», en cambio, se acepta cuando quien habla va ganando de verdad.
    expect(checkQuality("Voy ganando, Chispa.", lead(BRAVA, CHISPA))).toBeNull();
    // Las retiradas antes, por si alguna dejara de rechazarse.
    for (const [text, request] of [
      ["Abuela Pilar, la distancia ya es considerable.", say(ERNESTO, PILAR)],
      ["Chispa, a la abuela se la respeta.", say(PILAR, CHISPA, { kind: "capture_lament" })],
      ["Bien hecho, Chispa. Pero no te lo creas mucho, ¿eh?", say(PILAR, CHISPA, { kind: "victory_reply", trigger: "victory" })],
      ["Me he quedado con la ficha perdida, Brava.", say(CHISPA, BRAVA, { kind: "capture_lament" })],
      ["¡Ahora sí que te quedas atrás, Chispa!", say(BRAVA, CHISPA)],
      ["¡Qué mal te lo pasas, Chispa!", say(BRAVA, CHISPA)],
      ["Que mal te lo pasas, Chispa.", say(BRAVA, CHISPA)],
      ["Me he quedado sin ficha, Brava.", say(CHISPA, BRAVA, { kind: "capture_lament" })],
    ] as const) expect(reject(text, request)?.reason, text).toBe("expresión poco natural");
  });

  it("variantes de «tener» o «quedarse con» la ficha para contar una captura, y de «Bien visto»: detectadas y sin citarse", () => {
    for (const text of [
      "Ya tengo tu ficha.", "Tengo la suya, Abuela Pilar.", "Tienes la mía, Brava.", "Ya tiene mi ficha.", "Tenemos esa ficha.",
      "Me quedé con su ficha.", "Me quedo con la tuya.", "Quedarme con la ficha de Chispa ha sido fácil.", "Te has quedado con la mía.",
      "Se ha quedado con mi ficha.", "Muy bien visto, Chispa.", "¡Bien visto!",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("las frases naturales parecidas siguen valiendo", () => {
    for (const text of [
      "Tengo otra ficha en la meta.", "Tengo dos fichas en casa.", "Me he quedado con una ficha en casa.", "Tienes mi ficha a tiro, Brava.",
      "Me quedo con las ganas.", "Me has comido, Brava.", "Te comí, Chispa.", "Bien jugado, Brava.", "Voy ganando. Así me gusta.", "Se ve venir.",
    ]) expect(hasDiscardedExpression(text), text).toBe(false);
    expect(checkQuality("Tengo otra ficha en la meta.", say(BRAVA, CHISPA, { kind: "goal", trigger: "goal", important: false }))).toBeNull();
    expect(checkQuality("Me he quedado con una ficha en casa.", say(CHISPA, BRAVA, { kind: "ambient_behind", trigger: "ambient", important: false }))).toBeNull();
  });

  it("nadie dice su propio nombre ni se presenta (los cuatro, con nombre y alias); el rival sí se puede nombrar", () => {
    for (const [speaker, rival, name, check] of [
      [BRAVA, CHISPA, "Brava", "brava"], [ERNESTO, CHISPA, "Don Ernesto", "don ernesto"], [ERNESTO, CHISPA, "Ernesto", "ernesto"],
      [PILAR, CHISPA, "Abuela Pilar", "abuela pilar"], [PILAR, CHISPA, "Pilar", "pilar"], [CHISPA, BRAVA, "Chispa", "chispa"],
    ] as const) {
      expect(checkQuality(`Soy ${name}.`, say(speaker, rival)), name).toEqual({ reason: OWN, term: check });
      expect(checkQuality(`Aquí está ${name}, que no se rinde.`, say(speaker, rival)), name).toEqual({ reason: OWN, term: check });
    }
    expect(checkQuality("¡Otra para Chispa!", say(CHISPA, BRAVA))).toEqual({ reason: OWN, term: "chispa" });
    // El rival, la palabra común y «la abuela» de Pilar siguen valiendo.
    expect(checkQuality("Te comí, Chispa.", say(BRAVA, CHISPA))).toBeNull();
    expect(checkQuality("¡Qué jugada más brava, Chispa!", say(BRAVA, CHISPA))).toBeNull();
    expect(checkQuality("Hoy tengo una chispa de suerte.", say(CHISPA, BRAVA))).toBeNull();
    expect(checkQuality("La abuela también sabe, Chispa.", say(PILAR, CHISPA))).toBeNull();
  });

  it("el catálogo cumple: sin propio nombre, sin «Bien visto», sin «tener» o «quedarse con» la ficha, sin «Voy delante»", () => {
    for (const c of CHARACTERS) {
      for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases]) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name);
          expect(text, `${c.name}: ${text}`).not.toMatch(OWN_NAMES[c.id]);
          expect(text, `${c.name}: ${text}`).not.toMatch(/bien visto|voy (por )?delante|delante de todos|tengo (la tuya|tu ficha)|qued\p{L}* con (la tuya|tu ficha|su ficha)/iu);
        }
      }
    }
    const lines = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines;
    expect(lines(ERNESTO).capture_lament).toContain("Me ha comido una ficha, {rival}. Tendré que reorganizarme.");
    expect(lines(ERNESTO).ambient_lead).toContain("Voy ganando, y sin arriesgar.");
    expect(lines(PILAR).ambient_lead).toContain("Voy ganando, hijos, y sin correr nada.");
    expect(lines(CHISPA).capture_lament).toContain("¡Qué mala pata, {rival}! Vuelta a empezar.");
  });

  it("las sustitutas de captura pasan todas las reglas con cada rival", () => {
    for (const rival of [BRAVA, PILAR, CHISPA]) {
      const name = CHARACTERS.find((c) => c.id === rival)!.name;
      expect(reject(`Me ha comido una ficha, ${name}. Tendré que reorganizarme.`, say(ERNESTO, rival, { kind: "capture_lament", captures: factsOf([cap(10, rival, ERNESTO)], ERNESTO) })), name).toBeNull();
    }
    for (const rival of [BRAVA, ERNESTO, PILAR]) {
      const name = CHARACTERS.find((c) => c.id === rival)!.name;
      expect(reject(`¡Qué mala pata, ${name}! Vuelta a empezar.`, say(CHISPA, rival, { kind: "capture_lament", captures: factsOf([cap(10, rival, CHISPA)], CHISPA) })), name).toBeNull();
    }
  });

  it("la demostración no contiene ninguna, y nadie dice su propio nombre en ella", async () => {
    const { createDemoMatch } = await import("@/lib/board/demo");
    const match = await createDemoMatch();
    for (const m of match.messages) {
      expect(hasDiscardedExpression(m.text), m.text).toBe(false);
      expect(m.text, m.text).not.toMatch(OWN_NAMES[m.characterId]);
      expect(m.text, m.text).not.toMatch(/bien visto|delante/i);
    }
  });

  it("el prompt no cita frases recientes con estas expresiones", () => {
    const recent = [
      { speaker: BRAVA, text: "Tengo la tuya, Chispa." },
      { speaker: ERNESTO, text: "Me he quedado con la tuya, Chispa." },
      { speaker: PILAR, text: "Bien visto, Chispa." },
    ];
    const [system, user] = buildChatPrompt({ ...say(CHISPA, BRAVA, { kind: "capture_lament" }), recent });
    expect(`${system.content}\n${user.content}`).not.toMatch(/tengo la tuya|quedado con la tuya|bien visto/i);
  });
});

describe("ampliación de la revisión de lenguaje: deportes y otros juegos, frases retiradas y mensajes incoherentes", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const ALL = [BRAVA, ERNESTO, PILAR, CHISPA];
  const other = (speaker: string) => (speaker === BRAVA ? CHISPA : BRAVA);
  const lead = (speaker: string, rival: string) => ({ ...say(speaker, rival, { kind: "ambient_lead", trigger: "ambient", important: false }), leader: speaker });

  it("«gol» y sus derivados, las metáforas deportivas y otros juegos: rechazados para los cuatro (también en plural)", () => {
    for (const speaker of ALL) {
      for (const text of [
        "¡Gol!", "¡Golazo!", "¡Qué goles!", "Menuda goleada.", "¡Por la escuadra!", "¡Triple!", "¡Canasta!", "Esto es fútbol.", "Como en el baloncesto.",
        "Como en el tenis.", "Tres en raya.", "¡Jaque!", "Fuera de juego.", "¡Penalti!", "Eso son penaltis.", "¡Bingo!", "Dos canastas.",
      ]) expect(checkQuality(text, say(speaker, other(speaker)))?.reason, `${speaker}: ${text}`).toBe("expresión ajena al parchís");
    }
    // Palabras que solo empiezan igual no cuentan.
    for (const text of ["Golpe de suerte con el dado.", "Me has comido de golpe."]) expect(checkQuality(text, say(CHISPA, BRAVA, { kind: "capture_lament" })), text).toBeNull();
  });

  it("cada frase retirada se rechaza por el flujo completo del escritor LLM", () => {
    for (const [text, request] of [
      ["Te la he quitado, Abuela Pilar.", say(BRAVA, PILAR)],
      ["Me ha quitado una ficha.", say(PILAR, BRAVA, { kind: "capture_lament" })],
      ["Una captura de libro.", say(ERNESTO, BRAVA)],
      ["Y ahora a la meta en seis.", say(BRAVA, CHISPA)],
      ["Mantengo la ventaja.", say(ERNESTO, BRAVA)], ["Conservo la ventaja.", say(ERNESTO, BRAVA)], ["Sigo manteniendo la ventaja.", say(ERNESTO, BRAVA)],
      ["Sigo en la pelea.", say(BRAVA, CHISPA)], ["Sigo dando pelea.", say(BRAVA, CHISPA)], ["Seguimos en la pelea.", say(BRAVA, CHISPA)], ["Aún doy pelea.", say(BRAVA, CHISPA)],
      ["Voy en cabeza, Chispa.", lead(BRAVA, CHISPA)],
      ["¡Me la he quedado!", say(BRAVA, CHISPA)],
      ["Un contratiempo, Brava.", say(ERNESTO, BRAVA, { kind: "capture_lament" })],
      ["Me tiré un cuatro.", say(BRAVA, CHISPA)],
      ["Tu ficha, en la calle.", say(BRAVA, CHISPA)],
      ["¡He llegado a casa!", say(BRAVA, null, { kind: "goal", trigger: "goal", important: false })],
      ["¡Voy primero!", lead(CHISPA, BRAVA)], ["Voy primera, Chispa.", lead(BRAVA, CHISPA)],
      ["¡El dado castiga, pero Brava vuelve a empezar!", say(CHISPA, BRAVA)],
      ["¡Qué mala suerte! ¡Vamos por todas!", say(CHISPA, BRAVA, { kind: "capture_lament" })],
    ] as const) expect(reject(text, request), text).not.toBeNull();
  });

  it("los mensajes señalados como incoherentes se rechazan, con su motivo", () => {
    const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });
    expect(reject("¡Ojo con el siguiente!", say(BRAVA, CHISPA))).toEqual(term("ojo con el siguiente"));
    expect(reject("¡Maldición! Creo que hoy la luna está en mal aspecto... o quizás solo fui demasiado confiado.", say(CHISPA, BRAVA, { kind: "capture_lament" }))).toEqual(term("superstición"));
    expect(reject("¡Y el dado dice… esa ficha era la única que tenía a salvo, pobre Don Ernesto!", say(CHISPA, ERNESTO))).not.toBeNull();
    expect(checkQuality("Esa ficha era la única que tenía a salvo, Don Ernesto.", say(CHISPA, ERNESTO))).toEqual({ reason: "expresión poco natural", term: "explicación táctica" });
    expect(checkQuality("Ay, pobre Don Ernesto.", say(CHISPA, ERNESTO))).toEqual({ reason: "expresión poco natural", term: "pobre + nombre" });
    // «Previsible» con una explicación táctica inventada: se rechaza; «Previsible» con lo que ha pasado, no.
    expect(reject("Previsible, Brava. Ha dejado esa ficha sola.", say(ERNESTO, BRAVA, { captures: factsOf([cap(10, ERNESTO, BRAVA)], ERNESTO) }))).toEqual(term("explicación táctica"));
    expect(reject("Previsible, Brava. Le comí.", say(ERNESTO, BRAVA, { captures: factsOf([cap(10, ERNESTO, BRAVA)], ERNESTO) }))).toBeNull();
  });

  it("variantes equivalentes: detectadas y sin citarse en el prompt", () => {
    for (const text of [
      "Ya he llegado a casa.", "¡Llegué a casa!", "Llego a casa.", "¡A por todas!", "Voy a por todas.", "Vamos a por todas, Chispa.", "Ojo con la siguiente.",
      "Los astros no me acompañan.", "La luna anda en mal aspecto.", "Ay, pobre Brava.", "Dejaste tu ficha sin cubrir.", "Tenías la ficha desprotegida.",
      "¡Voy primero!", "Voy la primera.", "Y ahora a la meta en seis.", "Goleada.", "Eso son penaltis.",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("las frases naturales parecidas siguen valiendo", () => {
    for (const text of [
      "¡A casa!", "Vuelve a casa, Chispa.", "Una ficha más en la meta.", "Una menos. ¡A por las demás!", "Hay fichas por todas partes.", "¡Ojo con esa ficha!",
      "Hoy no tengo suerte.", "Pobre de mí.", "Previsible, Brava. Le comí.", "{rival}, le recomiendo no dejar fichas sueltas.", "Voy ganando. Así me gusta.",
      "Ya está, hijos: he llegado primera.", "Al primero que se me ponga a tiro, lo mando a casa.", "Golpe de suerte con el dado.",
    ]) expect(hasDiscardedExpression(text), text).toBe(false);
  });

  it("el catálogo, las coletillas y los caracteres no contienen ninguna, con cualquier rival; las sustitutas están en su sitio", () => {
    const FORBIDDEN =
      /(?<!\p{L})(?:gol\p{L}*|escuadra|triples?|canastas?|f[uú]tbol|baloncesto|tenis|tres en raya|jaques?|fuera de juego|penaltis?|bingo|quit\p{L}+ una ficha|te la he quitado|de libro|a la meta en|mantengo la ventaja|conservo la ventaja|en la pelea|dando pelea|doy pelea|en cabeza|me la he quedado|contratiempo|me tir[eé]|en la calle|lleg\p{L}* a casa|voy primer[oa]|la primera, y|el dado castiga|por todas|ojo con el siguiente|luna|astros|pobre (?:don|ernesto|pilar|brava|chispa)|ficha sola|unica que tenia a salvo|única que tenía a salvo)(?!\p{L})/iu;
    for (const c of CHARACTERS) {
      for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases, c.chat.voice]) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name);
          expect(text, `${c.name}: ${text}`).not.toMatch(FORBIDDEN);
        }
      }
    }
    const lines = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.lines;
    expect(lines(ERNESTO).capture_boast).toContain("Previsible, {rival}. Le comí.");
    expect(lines(CHISPA).ambient_lead).toContain("¡Voy ganando! Ni yo me lo esperaba.");
    expect(lines(PILAR).ambient_lead).toContain("Ay, quién me lo iba a decir: voy ganando.");
    // «Previsible» sigue siendo una coletilla de Don Ernesto.
    expect(CHARACTERS.find((c) => c.id === ERNESTO)!.catchphrases).toContain("Previsible");
  });

  it("la sustituta de Don Ernesto pasa todas las reglas con cada rival", () => {
    for (const rival of [BRAVA, PILAR, CHISPA]) {
      const name = CHARACTERS.find((c) => c.id === rival)!.name;
      expect(reject(`Previsible, ${name}. Le comí.`, say(ERNESTO, rival, { captures: factsOf([cap(10, ERNESTO, rival)], ERNESTO) })), name).toBeNull();
    }
  });

  it("la demostración no contiene ninguna, y la v62 de Don Ernesto ya no inventa la explicación", async () => {
    const { createDemoMatch } = await import("@/lib/board/demo");
    const match = await createDemoMatch();
    for (const m of match.messages) {
      expect(hasDiscardedExpression(m.text), m.text).toBe(false);
      expect(m.text, m.text).not.toMatch(/(?<!\p{L})gol\p{L}*|ficha sola|a salvo|voy primer|la primera/iu);
    }
    expect(match.messages.find((m) => m.version === 62 && m.seq === 0)?.text).toBe("Previsible, Abuela Pilar. Le comí.");
  });

  it("el prompt no menciona deportes ni otros juegos, y no cita frases recientes con estas expresiones", () => {
    const recent = [
      { speaker: CHISPA, text: "¡Golazo por la escuadra!" },
      { speaker: BRAVA, text: "¡Qué mala suerte! ¡Vamos por todas!" },
      { speaker: ERNESTO, text: "Previsible, Chispa. Ha dejado esa ficha sola." },
    ];
    for (const speaker of ALL) {
      const [system, user] = buildChatPrompt({ ...say(speaker, other(speaker), { kind: "capture_lament" }), recent });
      expect(`${system.content}\n${user.content}`, speaker).not.toMatch(/(?<!\p{L})gol\p{L}*|escuadra|f[uú]tbol|comentarista|por todas|ficha sola/iu);
    }
  });
});

describe("revisión de los mensajes reales de Preview: «va perdiendo», tratamiento y frases retiradas", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });
  const victim = (speaker: string, by: string) => say(speaker, by, { kind: "capture_lament", captures: factsOf([cap(10, by, speaker)], speaker) });

  it("los mensajes reales señalados se rechazan por el flujo completo del escritor LLM", () => {
    expect(reject("Brava sigue perdida.", say(CHISPA, BRAVA))).toEqual(term("sigue perdido"));
    expect(reject("Me has comido una ficha, Chispa.", victim(BRAVA, CHISPA))).toEqual(term("sin exclamaciones (Brava)"));
    expect(reject("Lo anoto, Chispa. No volverá a ocurrir.", victim(ERNESTO, CHISPA))).toEqual(term("no volverá a ocurrir"));
    expect(reject("Tengo que esperar mi turno.", say(ERNESTO, CHISPA, { kind: "capture_lament" }))).toEqual(term("esperar mi turno"));
  });

  it("variantes equivalentes, detectadas y sin citarse en el prompt", () => {
    for (const text of [
      "Chispa sigue perdido.", "Sigues perdida, Brava.", "Estás perdido, Chispa.", "Ya estoy perdida.", "Brava anda muy perdida.",
      "No volverá a pasar.", "No va a volver a ocurrir.", "No se repetirá.", "Esto no pasará más.",
      "Me toca esperar mi turno.", "Esperaré mi turno.", "A esperar el turno.",
    ]) expect(hasDiscardedExpression(text), text).toBe(true);
    for (const text of ["Brava va perdiendo.", "Voy perdiendo, pero aún quedan muchas tiradas.", "Bueno, turno perdido. Sin prisa.", "¡Tres seises, Brava! Te toca esperar.", "Lo anoto, Chispa."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
  });

  it("Brava: «¡Me has comido una ficha!» con exclamaciones se acepta; sin ellas, no", () => {
    for (const text of ["¡Me has comido una ficha, Chispa!", "¡Chispa, me has comido una ficha!", "¡Me has comido una ficha! Te vas a enterar, Chispa."]) {
      expect(reject(text, victim(BRAVA, CHISPA)), text).toBeNull();
    }
    for (const text of ["Me has comido una ficha, Chispa.", "Me has comido una ficha, Chispa!", "¡Vaya! Me has comido una ficha, Chispa."]) {
      expect(reject(text, victim(BRAVA, CHISPA)), text).toEqual(term("sin exclamaciones (Brava)"));
    }
    // Los demás no tienen esta obligación.
    expect(reject("Me has comido una ficha, Brava.", victim(CHISPA, BRAVA))).toBeNull();
    expect(reject("Me has comido una ficha, Brava.", victim(PILAR, BRAVA))).toBeNull();
  });

  it("«señores» es exclusivo de Chispa", () => {
    expect(checkQuality("¡Qué partida, señores!", say(CHISPA, BRAVA, { kind: "ambient_ahead", trigger: "ambient", important: false }))).toBeNull();
    for (const speaker of [BRAVA, ERNESTO, PILAR]) {
      expect(checkQuality("¡Qué partida, señores!", say(speaker, CHISPA, { kind: "ambient_ahead", trigger: "ambient", important: false })), speaker).toEqual({ reason: "expresión poco natural", term: "señores (solo Chispa)" });
    }
  });

  it("Abuela Pilar: «cariño» a un solo jugador e «hijos» al grupo, nunca a una sola persona", () => {
    expect(reject("Me has comido, Brava, cariño. Qué le vamos a hacer.", victim(PILAR, BRAVA))).toBeNull();
    expect(checkQuality("Ya he terminado, hijos.", say(PILAR, null, { kind: "finish_place", trigger: "finish_place", important: false }))).toBeNull();
    expect(checkQuality("¿Pero qué os he hecho yo, hijos?", say(PILAR, BRAVA, { kind: "streak_lament", trigger: "bad_streak" }))).toBeNull();
    for (const text of ["Ay, hijos, me has comido.", "Hijos, tú no tienes prisa.", "Te comí, hijos.", "Hijos, ya te pillaré."]) {
      expect(checkQuality(text, say(PILAR, BRAVA)), text).toEqual({ reason: "expresión poco natural", term: "hijos a una sola persona" });
    }
    // «cariños» al grupo sigue retirado.
    expect(checkQuality("Ay, cariños, qué partida.", say(PILAR, BRAVA))).toEqual({ reason: "expresión poco natural", term: "cariños" });
  });

  it("el catálogo cumple: sin las frases retiradas, Brava con exclamaciones, «señores» solo de Chispa y los «hijos» de Pilar, al grupo", () => {
    for (const c of CHARACTERS) {
      for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases]) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name);
          expect(text, `${c.name}: ${text}`).not.toMatch(/sigue perdid|no volver[aá] a ocurrir|esperar mi turno/i);
          if (c.id !== CHISPA) expect(text, `${c.name}: ${text}`).not.toMatch(/señores/i);
          if (c.id === BRAVA && /me has comido una ficha/i.test(text)) expect(text, text).toMatch(/¡[^.!?]*me has comido una ficha[^.!?]*!/i);
          if (c.id === PILAR && /\bhijos\b/i.test(text)) expect(checkQuality(text, say(PILAR, rival.id, { kind: "ambient_ahead", trigger: "ambient", important: false }))?.term, text).not.toBe("hijos a una sola persona");
        }
      }
    }
    const lament = CHARACTERS.find((c) => c.id === ERNESTO)!.chat.lines.capture_lament;
    expect(lament).toContain("Lo anoto, {rival}. Me ha pillado desprevenido.");
    expect(lament).not.toContain("Lo anoto, {rival}. No volverá a ocurrir.");
  });

  it("la sustituta de Don Ernesto pasa todas las reglas con cada rival, de usted", () => {
    for (const rival of [BRAVA, PILAR, CHISPA]) {
      const name = CHARACTERS.find((c) => c.id === rival)!.name;
      expect(reject(`Lo anoto, ${name}. Me ha pillado desprevenido.`, victim(ERNESTO, rival)), name).toBeNull();
    }
  });

  it("la demostración no contiene ninguna de estas expresiones", async () => {
    const { createDemoMatch } = await import("@/lib/board/demo");
    const match = await createDemoMatch();
    for (const m of match.messages) {
      expect(hasDiscardedExpression(m.text), m.text).toBe(false);
      expect(m.text, m.text).not.toMatch(/sigue perdid|no volver[aá] a ocurrir|esperar mi turno/i);
      if (m.characterId !== CHISPA) expect(m.text, m.text).not.toMatch(/señores/i);
    }
  });
});

describe("posición real: «voy ganando» / «voy perdiendo» solo con la clasificación del servidor (`leader`, `last`)", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const NOT_BACKED = "afirmación no respaldada";
  const at = (speaker: string, rival: string | null, leader: string | null | undefined, last: string | null | undefined) => ({
    ...say(speaker, rival, { kind: "capture_boast", captures: factsOf([cap(10, speaker, rival ?? BRAVA)], speaker) }),
    ...(leader !== undefined ? { leader } : {}),
    ...(last !== undefined ? { last } : {}),
  });

  it("por el flujo completo del escritor LLM: líder, último, intermedio, empate y sin estado", () => {
    expect(reject("¡Te comí, Chispa! Voy ganando.", at(BRAVA, CHISPA, BRAVA, CHISPA))).toBeNull();
    expect(reject("¡Te comí, Chispa! Voy ganando.", at(BRAVA, CHISPA, ERNESTO, CHISPA))?.reason).toBe(NOT_BACKED);
    expect(reject("Te comí, Brava. Aunque voy perdiendo.", at(CHISPA, BRAVA, BRAVA, CHISPA))).toBeNull();
    expect(reject("Te comí, Brava. Aunque voy perdiendo.", at(PILAR, BRAVA, BRAVA, CHISPA))?.reason).toBe(NOT_BACKED);
    expect(reject("¡Te comí, Chispa! Voy ganando.", at(BRAVA, CHISPA, null, CHISPA))?.reason).toBe(NOT_BACKED);
    expect(reject("Te comí, Brava. Aunque voy perdiendo.", at(CHISPA, BRAVA, BRAVA, null))?.reason).toBe(NOT_BACKED);
    expect(reject("¡Te comí, Chispa! Voy ganando.", at(BRAVA, CHISPA, undefined, undefined))?.reason).toBe(NOT_BACKED);
  });

  it("afirmaciones sobre el rival, con su posición real", () => {
    expect(reject("¡Te comí, Chispa! Y vas perdiendo.", at(BRAVA, CHISPA, BRAVA, CHISPA))).toBeNull();
    expect(reject("¡Te comí, Chispa! Y vas perdiendo.", at(BRAVA, CHISPA, BRAVA, PILAR))?.reason).toBe(NOT_BACKED);
    expect(reject("¡Te comí, Chispa! Te has quedado muy atrás.", at(BRAVA, CHISPA, BRAVA, CHISPA))).toBeNull();
    expect(reject("¡Te comí, Chispa! Te has quedado muy atrás.", at(BRAVA, CHISPA, BRAVA, null))?.reason).toBe(NOT_BACKED);
  });

  it("lo que nunca se respalda sigue rechazado, aunque la posición sea cierta", () => {
    for (const text of ["¡Te comí, Chispa! Voy primera.", "¡Te comí, Chispa! Voy en cabeza.", "¡Te comí, Chispa! Voy delante.", "¡Te comí, Chispa! Vas el último.", "¡Te comí, Chispa! Voy por detrás de ti."]) {
      expect(reject(text, at(BRAVA, CHISPA, BRAVA, CHISPA)), text).not.toBeNull();
    }
  });
});

describe("«Me la he comido», «Ya va siendo hora» y afirmar que un rival gana (mensajes reales de Preview)", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });
  const capturer = (speaker: string, victim: string) => say(speaker, victim, { kind: "capture_boast", captures: factsOf([cap(10, speaker, victim)], speaker) });
  const victimOf = (speaker: string, by: string) => say(speaker, by, { kind: "capture_lament", captures: factsOf([cap(10, by, speaker)], speaker) });

  it("el mensaje real de Brava se rechaza por el flujo completo", () => {
    expect(reject("¡Abuela, me la he comido y ya va siendo hora!", capturer(BRAVA, PILAR))).toEqual(term("me la he comido"));
  });

  it("«Me la he comido» y sus variantes en primera persona: rechazadas y sin citarse", () => {
    for (const text of ["¡Me la he comido!", "Me la comí, Chispa.", "Me la como.", "Me las he comido.", "Nos la hemos comido.", "Me la acabo de comer.", "Me la voy a comer.", "Voy a comérmela.", "Me la comeré."]) {
      expect(reject(text, capturer(BRAVA, CHISPA)), text).toEqual(term("me la he comido"));
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("«Ya va siendo hora» y sus variantes: rechazadas y sin citarse", () => {
    for (const text of ["Ya va siendo hora.", "Va siendo hora, Chispa.", "Ya iba siendo hora.", "¡Ya era hora!", "Ya es hora."]) {
      expect(reject(text, capturer(BRAVA, CHISPA)), text).toEqual(term("ya va siendo hora"));
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
    for (const text of ["Por ahora, voy bien.", "Ahora me toca a mí.", "Ya es la hora de la merienda."]) expect(hasDiscardedExpression(text), text).toBe(false);
  });

  it("siguen valiendo las capturas aprobadas, también «Te la he comido» y «¡Me la has comido!», en su lado", () => {
    expect(reject("Te comí, Chispa.", capturer(BRAVA, CHISPA))).toBeNull();
    expect(reject("¡Te la he comido, Chispa!", capturer(BRAVA, CHISPA))).toBeNull();
    expect(reject("Me comiste, Brava.", victimOf(CHISPA, BRAVA))).toBeNull();
    expect(reject("¡Me la has comido, Brava!", victimOf(CHISPA, BRAVA))).toBeNull();
    expect(reject("Le comí, Brava.", capturer(ERNESTO, BRAVA))).toBeNull();
    expect(reject("Se la he comido, Brava.", capturer(ERNESTO, BRAVA))).toBeNull();
    expect(reject("Me comió usted, Brava.", victimOf(ERNESTO, BRAVA))).toBeNull();
    expect(reject("Me como su ficha, Brava.", capturer(ERNESTO, BRAVA))).toBeNull();
    for (const text of ["Te comí, Chispa.", "¡Te la he comido, Chispa!"]) expect(hasDiscardedExpression(text), text).toBe(false);
  });

  it("…pero contadas al revés se rechazan: «Te la he comido» de quien pierde la ficha y «Me la has comido» de quien la come", () => {
    expect(reject("¡Te la he comido, Chispa!", victimOf(BRAVA, CHISPA))?.reason).toBe("contradice quién captura");
    expect(reject("Se la he comido, Brava.", victimOf(ERNESTO, BRAVA))?.reason).toBe("contradice quién captura");
    expect(reject("¡Me la has comido, Chispa!", capturer(BRAVA, CHISPA))?.reason).toBe("contradice quién captura");
  });

  it("«No me extraña que Brava gane» sin ganador: rechazada, con sus variantes", () => {
    const NOT_BACKED = "afirmación no respaldada";
    expect(reject("No me extraña que Brava gane.", victimOf(PILAR, BRAVA))).toEqual({ reason: NOT_BACKED, detail: expect.stringMatching(/^termino=extraña que brava gane/) });
    for (const text of ["No me extraña que ganes, Brava.", "Normal que ganes, Brava.", "Brava va a ganar.", "Vas a ganar, Brava.", "Eres la ganadora, Brava.", "Brava gana la partida.", "No me extraña que gane, Brava."]) {
      expect(reject(text, victimOf(PILAR, BRAVA))?.reason, text).toBe(NOT_BACKED);
    }
  });

  it("con un ganador real: solo si el rival es quien ha ganado", () => {
    const after = (winner: string) => ({ ...victimOf(PILAR, BRAVA), winner });
    expect(reject("No me extraña que Brava gane.", after(BRAVA))).toBeNull();
    expect(reject("No me extraña que Brava gane.", after(CHISPA))?.reason).toBe("afirmación no respaldada");
    // En la réplica a una victoria el rival es el ganador, aunque falte el dato (victoria en modo mínimo).
    const reply = say(PILAR, BRAVA, { kind: "victory_reply", trigger: "victory" });
    expect(reject("No me extraña que ganes, Brava.", reply)).toBeNull();
    // En la propia victoria no hay rival del que decir que gana.
    expect(checkQuality("¡No me extraña que ganes!", say(BRAVA, null, { kind: "victory_win", trigger: "victory" }))?.reason).toBe("afirmación no respaldada");
  });

  it("no son afirmaciones de victoria: deseos, hipótesis, «que gane el mejor» y otros sentidos de «ganar»", () => {
    for (const text of ["Ojalá gane Brava.", "Si ganas, Brava, te invito.", "A ver si gana Brava.", "Que gane el mejor.", "Brava gana terreno.", "Brava gana una ficha más.", "Me da la gana, Brava."]) {
      expect(checkQuality(text, victimOf(PILAR, BRAVA))?.reason, text).not.toBe("afirmación no respaldada");
    }
  });

  it("el catálogo, las coletillas y la demostración no contienen ninguna", async () => {
    for (const c of CHARACTERS) {
      for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases, c.chat.voice]) {
        expect(line, `${c.name}: ${line}`).not.toMatch(/me las? (he comido|comí|como)|comérmela|(va|iba) siendo hora|ya (era|es) hora|extraña que/i);
      }
    }
    const { createDemoMatch } = await import("@/lib/board/demo");
    for (const m of (await createDemoMatch()).messages) {
      expect(hasDiscardedExpression(m.text), m.text).toBe(false);
      expect(m.text, m.text).not.toMatch(/me las? (he comido|comí)|siendo hora|extraña que/i);
    }
  });

  it("el prompt no las cita desde los textos recientes", () => {
    const recent = [{ speaker: BRAVA, text: "¡Abuela, me la he comido y ya va siendo hora!" }, { speaker: CHISPA, text: "¡Ya era hora!" }];
    const [system, user] = buildChatPrompt({ ...victimOf(PILAR, BRAVA), recent });
    expect(`${system.content}\n${user.content}`).not.toMatch(/me la he comido|siendo hora|ya era hora/i);
  });
});

describe("comentar la jugada, no narrarla («Le he comido una ficha a Brava y vuelve a su casa»)", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const NARRATION = { reason: "expresión poco natural", detail: "termino=narración de la jugada" };
  const capturer = (speaker: string, victim: string) => say(speaker, victim, { kind: "capture_boast", captures: factsOf([cap(10, speaker, victim)], speaker) });
  const victimOf = (speaker: string, by: string) => say(speaker, by, { kind: "capture_lament", captures: factsOf([cap(10, by, speaker)], speaker) });

  it("el mensaje real de Don Ernesto se rechaza por el flujo completo, y la frase pedida se acepta con cada rival", () => {
    expect(reject("Le he comido una ficha a Brava y vuelve a su casa.", capturer(ERNESTO, BRAVA))).toEqual(NARRATION);
    for (const rival of [BRAVA, PILAR, CHISPA]) {
      const name = CHARACTERS.find((c) => c.id === rival)!.name;
      expect(reject(`${name}, le he comido una ficha.`, capturer(ERNESTO, rival)), name).toBeNull();
    }
  });

  it("variantes que encadenan la captura y su consecuencia: rechazadas y sin citarse", () => {
    for (const [text, request] of [
      ["Te comí y vuelves a casa, Chispa.", capturer(BRAVA, CHISPA)],
      ["Te he pillado y tu ficha vuelve a casa, Chispa.", capturer(BRAVA, CHISPA)],
      ["Chispa, esa ficha vuelve a su casa.", capturer(BRAVA, CHISPA)],
      ["Me has comido y vuelvo a casa, Brava.", victimOf(CHISPA, BRAVA)],
      ["Le he comido una ficha a Chispa y se va a su casa.", capturer(ERNESTO, CHISPA)],
    ] as const) {
      expect(reject(text, request), text).toEqual(NARRATION);
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("las reacciones cortas siguen valiendo", () => {
    for (const [text, request] of [
      ["¡Te comí, Chispa! A casa.", capturer(BRAVA, CHISPA)],
      ["¡A casa, Chispa!", capturer(BRAVA, CHISPA)],
      ["Vuelve a casa, Chispa.", capturer(BRAVA, CHISPA)],
      ["¡Te he comido, Chispa! Vuelta a empezar.", capturer(BRAVA, CHISPA)],
      ["Ay, qué pena. A casita, Chispa.", capturer(PILAR, CHISPA)],
      ["Me has comido, Brava. Qué le vamos a hacer.", victimOf(PILAR, BRAVA)],
    ] as const) expect(reject(text, request), text).toBeNull();
  });

  it("el catálogo y la demostración no narran jugadas", async () => {
    for (const c of CHARACTERS) {
      for (const line of Object.values(c.chat.lines).flat()) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name);
          expect(hasDiscardedExpression(text), `${c.name}: ${text}`).toBe(false);
        }
      }
    }
    const { createDemoMatch } = await import("@/lib/board/demo");
    for (const m of (await createDemoMatch()).messages) expect(m.text, m.text).not.toMatch(/vuelve a su casa|\by vuelves? a casa/i);
  });

  it("el prompt ya no sugiere la consecuencia y pide comentar sin narrar; tampoco cita frases narradas", () => {
    const recent = [{ speaker: ERNESTO, text: "Le he comido una ficha a Brava y vuelve a su casa." }];
    for (const [speaker, rival, kind] of [[ERNESTO, BRAVA, "capture_boast"], [BRAVA, ERNESTO, "capture_lament"]] as const) {
      const [system, user] = buildChatPrompt({ ...say(speaker, rival, { kind }), recent });
      const prompt = `${system.content}\n${user.content}`;
      expect(prompt, kind).not.toMatch(/vuelve a (su|tu) casa/i);
      expect(user.content, kind).toContain("coméntalo sin narrarlo");
    }
  });
});

describe("«Eso me viene muy bien», «Me he quedado solo en la meta» y atribuir pensamientos o emociones a otros", () => {
  const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];
  const term = (t: string) => ({ reason: "expresión poco natural", detail: `termino=${t}` });
  const unbacked = (t: string) => ({ reason: "afirmación no respaldada", detail: `termino=${t}` });
  const capturer = (speaker: string, victim: string) => say(speaker, victim, { kind: "capture_boast", captures: factsOf([cap(10, speaker, victim)], speaker) });
  const victimOf = (speaker: string, by: string) => say(speaker, by, { kind: "capture_lament", captures: factsOf([cap(10, by, speaker)], speaker) });
  const tease = (speaker: string, rival: string) => say(speaker, rival, { kind: "third_six_tease", trigger: "third_six", important: false });

  it("«Eso me viene muy bien» y sus variantes: rechazadas por el flujo completo y sin citarse", () => {
    for (const text of ["Chispa, eso me viene muy bien.", "Eso me viene de perlas, Chispa.", "Me viene genial, Chispa.", "Esto me ha venido muy bien.", "Me vino que ni pintado."]) {
      expect(reject(text, tease(BRAVA, CHISPA)), text).toEqual(term("me viene muy bien"));
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("«Me he quedado solo en la meta» y sus variantes: rechazadas y sin citarse", () => {
    for (const text of ["Me he quedado solo en la meta.", "Me he quedado sola en la meta, Chispa.", "Me quedo solo en la meta.", "Estoy sola en la meta."]) {
      expect(reject(text, say(BRAVA, CHISPA, { kind: "goal", trigger: "goal", important: false })), text).toEqual(term("solo en la meta"));
      expect(hasDiscardedExpression(text), text).toBe(true);
    }
  });

  it("el mensaje real y otras atribuciones de pensamientos, intenciones o emociones a otro jugador se rechazan", () => {
    expect(reject("¡Vaya, y tú pensando que tenías la partida ganada!", capturer(CHISPA, BRAVA))).toEqual(unbacked("atribuye pensamientos"));
    for (const [text, expected, request] of [
      ["Te creías la ganadora, Brava.", "atribuye pensamientos", capturer(CHISPA, BRAVA)],
      ["Pensabas que no te pillaba, Brava.", "atribuye pensamientos", capturer(CHISPA, BRAVA)],
      ["Ya te veías en la meta, Brava.", "atribuye pensamientos", capturer(CHISPA, BRAVA)],
      ["Esperabas otra cosa, Brava.", "atribuye pensamientos", capturer(CHISPA, BRAVA)],
      ["Creía usted que se libraba, Brava.", "atribuye pensamientos", capturer(ERNESTO, BRAVA)],
      ["Ibas a por mí, Brava.", "atribuye intenciones", victimOf(CHISPA, BRAVA)],
      ["Querías salir de casa, Brava.", "atribuye intenciones", capturer(CHISPA, BRAVA)],
      ["Estás nerviosa, Brava.", "atribuye emociones", capturer(CHISPA, BRAVA)],
      ["Te veo muy preocupada, Brava.", "atribuye emociones", capturer(CHISPA, BRAVA)],
      ["Te has enfadado, Brava.", "atribuye emociones", capturer(CHISPA, BRAVA)],
      ["Está usted muy contenta, Brava.", "atribuye emociones", victimOf(ERNESTO, BRAVA)],
    ] as const) {
      expect(reject(text, request), text).toEqual(unbacked(expected));
    }
    for (const text of ["Tú pensando que tenías la partida ganada.", "Te creías la ganadora.", "Estás nerviosa.", "Ibas a por mí."]) expect(hasDiscardedExpression(text), text).toBe(true);
  });

  it("los mensajes naturales siguen valiendo: lo que dice de sí mismo quien habla, exhortaciones y reacciones", () => {
    for (const [text, request] of [
      ["Creía que me ibas a comer, Brava.", victimOf(CHISPA, BRAVA)],
      ["Pensaba que te ibas a escapar, Brava.", capturer(CHISPA, BRAVA)],
      ["¡Qué contenta estoy! Te comí, Chispa.", capturer(BRAVA, CHISPA)],
      ["No te confíes, Chispa.", capturer(BRAVA, CHISPA)],
      ["Tú tranquila, Brava, que ya te pillaré.", victimOf(CHISPA, BRAVA)],
      ["Te veo venir, Brava.", victimOf(CHISPA, BRAVA)],
      ["Me has comido, Brava. Qué le vamos a hacer.", victimOf(PILAR, BRAVA)],
      ["¡Te comí, Chispa! A casa.", capturer(BRAVA, CHISPA)],
      ["Tres seises, Chispa. Te quedas sin turno.", tease(BRAVA, CHISPA)],
      ["Me viene el turno, Chispa.", tease(BRAVA, CHISPA)],
      ["Una ficha más en la meta.", say(BRAVA, null, { kind: "goal", trigger: "goal", important: false })],
    ] as const) expect(reject(text, request), text).toBeNull();
  });

  it("catálogo, coletillas y demostración: sin estas expresiones ni atribuciones; la frase de Brava, sustituida", async () => {
    for (const c of CHARACTERS) {
      for (const line of [...Object.values(c.chat.lines).flat(), ...c.catchphrases]) {
        for (const rival of CHARACTERS.filter((r) => r.id !== c.id)) {
          const text = line.replaceAll("{rival}", rival.name);
          expect(hasDiscardedExpression(text), `${c.name}: ${text}`).toBe(false);
        }
      }
    }
    const tease = CHARACTERS.find((c) => c.id === BRAVA)!.chat.lines.third_six_tease;
    expect(tease).not.toContain("{rival}, eso me viene muy bien.");
    expect(tease).toContain("{rival}, ¡te has pasado de seises!");
    const { createDemoMatch } = await import("@/lib/board/demo");
    for (const m of (await createDemoMatch()).messages) expect(hasDiscardedExpression(m.text), m.text).toBe(false);
  });

  it("el prompt pide no inventar lo que piensan otros y no cita frases recientes con estas expresiones", () => {
    const recent = [{ speaker: BRAVA, text: "Chispa, eso me viene muy bien." }, { speaker: CHISPA, text: "¡Vaya, y tú pensando que tenías la partida ganada!" }];
    for (const speaker of [BRAVA, ERNESTO, PILAR, CHISPA]) {
      const [system, user] = buildChatPrompt({ ...say(speaker, speaker === BRAVA ? CHISPA : BRAVA, { kind: "capture_lament" }), recent });
      expect(system.content, speaker).toContain("ni qué piensan otros");
      expect(user.content, speaker).not.toMatch(/me viene muy bien|pensando que/i);
    }
  });
});
