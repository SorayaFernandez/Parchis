import { describe, expect, it } from "vitest";
import { CHARACTERS } from "@/lib/game/characters";
import { captureFacts, type Utterance } from "../../director";
import type { RecentText } from "../../writer";
import { ChatLlmError, cleanLlmText, INVALID_RESPONSE_REASONS } from "../gatewayWriter";
import { COMMENTATOR, OTHER_GAMES, QUALITY_REASONS, SPORTS_METAPHORS, checkQuality, countSentences, hasDiscardedExpression } from "../quality";

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
    ok("Estadísticamente era inevitable.", say("ai-purple", "ai-green", { replyTo: 0 }));
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
    ok("Ay, cariño, esa ficha vuelve a su casita. Despacito se llega lejos, Chispa.", say("ai-green", "ai-blue"));
  });

  it("expresiones naturales de competición y préstamos sueltos", () => {
    ok("¡Voy a por ti, Don Ernesto! Esta partida es mía.", say("ai-blue", "ai-purple"));
    ok("¡Has perdido una ficha, Brava! Vuelve a empezar.", say("ai-blue", "ai-pink"));
    ok("Es la primera vez que me pasa, ¡qué escándalo!", say("ai-blue", "ai-pink", { kind: "capture_lament" }));
    ok("¡Qué crack eres, Brava! Menudo show.", say("ai-blue", "ai-pink", { kind: "capture_lament" }));
    ok("Ni en el mejor game de la tele se ve esto, Chispa.", say("ai-pink", "ai-blue"));
    ok("¡Vuelve a casa, Chispa! ¿Quién se atreve ahora?", say("ai-pink", "ai-blue", {}, [{ speaker: "ai-pink", text: "¡A casa!" }]));
    ok("¡He ganado la partida! ¿Quién es el siguiente?", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }));
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
    expect(reject("Pilar, esa ficha vuelve a su casa, como estaba previsto.", say("ai-purple", "ai-green"))).toBeNull();
    expect(reject("Abuela Pilar, esa ficha vuelve a su casa.", say("ai-blue", "ai-green"))).toBeNull();
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
      ["Esto es un golazo, Chispa.", "golazo"],
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

  it("Chispa (comentarista) puede usar metáforas deportivas en frases naturales; no las reglas de otros juegos", () => {
    // La frase local de Chispa y otras metáforas de comentarista, en su boca, pasan por cleanLlmText completo.
    expect(reject("¡Golazo por la escuadra! Brava, a casa a por agua.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡Gol de Chispa! Qué jugada, señores.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡Triple sobre la bocina, Brava!", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡Canasta desde casa! Brava, a empezar de nuevo.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡Fuera de juego, Brava!", say("ai-blue", "ai-pink"))?.reason).toBe("expresión ajena al parchís");
  });

  // Cada término por separado, en una frase que no contiene ningún otro término de las listas.
  const sentence = (term: string) => `Eso ha sido ${term}, compañero.`;
  const OTHERS = ["ai-pink", "ai-purple", "ai-green"] as const;

  it("la frase de prueba, sin término, se acepta para los cuatro (sin falsos positivos)", () => {
    for (const speaker of [COMMENTATOR, ...OTHERS]) {
      expect(checkQuality("Eso ha sido increíble, compañero.", say(speaker, speaker === COMMENTATOR ? "ai-pink" : COMMENTATOR)), speaker).toBeNull();
    }
  });

  it.each(SPORTS_METAPHORS.map((term) => [term]))("metáfora deportiva «%s»: Chispa la acepta y los otros tres la rechazan", (term) => {
    expect(checkQuality(sentence(term), say(COMMENTATOR, "ai-pink"))).toBeNull();
    for (const speaker of OTHERS) {
      expect(checkQuality(sentence(term), say(speaker, COMMENTATOR)), speaker).toEqual({ reason: "expresión ajena al parchís", term });
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
    expect(checkQuality("¡Y el dado dice que otra para mí!", say("ai-blue", "ai-pink", {}, [{ speaker: "ai-blue", text: "¡Y el dado dice… Brava ha caído!" }]))?.term).toBe("¡Y el dado dice…!");
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

  it("B: permite su nombre en construcciones válidas y nombrar a los rivales en tercera persona", () => {
    // Construcciones válidas con el propio nombre.
    expect(reject("¡Gol de Chispa! Qué jugada, señores.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("Soy Brava y nunca fallo, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
    expect(reject("Le habla Don Ernesto: era previsible, Chispa.", say("ai-purple", "ai-blue"))).toBeNull();
    // Rivales en tercera persona (con artículo o verbo): no es hablar de sí mismo.
    expect(reject("¡Brava ha caído! Y el dado lo ha visto.", say("ai-blue", "ai-pink"))).toBeNull();
    expect(reject("¡La abuela se lleva un susto! A casa esa ficha.", say("ai-blue", "ai-green"))).toBeNull();
    expect(reject("Chispa no aprende, cariño.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Don Ernesto nunca se rinde, Chispa lo sabe.", say("ai-blue", "ai-purple"))).toBeNull();
    // Pilar llamándose «la abuela» es parte de su personaje (sus frases locales lo usan).
    expect(reject("Ay, la abuela no corre tanto, Chispa.", say("ai-green", "ai-blue"))).toBeNull();
    expect(reject("Felicidades, Chispa. A la próxima, la abuela se pone seria.", say("ai-green", "ai-blue", { kind: "victory_reply", trigger: "victory" }))).toBeNull();
    // Palabras comunes: «abuela» genérica dicha por Pilar y «brava» como adjetivo dicha por Brava.
    expect(reject("Mi abuela siempre decía: despacito, cariño.", say("ai-green", "ai-blue"))).toBeNull();
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
    expect(checkQuality("¡Es la primera vez que gano, señores!", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
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
    expect(checkQuality("Me has pillado, sí. Piénsalo dos veces, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
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
    // Cifras que no son ordinales: «2 a casa», «de 1 a 3 casillas», «3 o 4 casillas», «la 2 de la meta».
    for (const text of ["Con un 5 salgo y 2 a casa, Chispa.", "De 1 a 3 casillas me separan, Chispa.", "Me faltan 3 o 4 casillas, Chispa.", "La casilla 2 de la meta es mía, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    // «1ª vez» y «primera vez» no cuentan capturas.
    expect(checkQuality("Es la 1ª vez que gano, señores.", say("ai-pink", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
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
      "Me faltan cinco casillas para la meta, Chispa.",
      "Con un 5 salgo de casa, ya verás, Chispa.",
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
      for (const text of ["Me quedan dos fichas en casa, Brava.", "Llevo dos fichas en la meta, Brava.", "Tengo tres fichas fuera, Brava."]) {
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
      for (const text of ["Llevo dos fichas en la meta, Brava.", "Van dos fichas en casa, Brava.", "Ya son las tres, Brava.", "Con un 5 salgo, Brava."]) {
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
        expect(checkQuality("Me has pillado una vez más, Brava.", victimReq())).toBeNull(); // expresión hecha
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
    expect(reject("Pues eso es lo que tiene jugar con las que más quieres, hijita", say("ai-green", "ai-pink"))).toBeNull();
    expect(reject("La vida son juegos, hijito, y las fichas se van.", say("ai-green", "ai-blue"))).toBeNull();
  });

  it("los dos sentidos con los cuatro destinatarios, también Don Ernesto", () => {
    for (const [speaker, rival, text, ok] of [
      ["ai-green", "ai-pink", "Ay, hijita, a casita.", true],
      ["ai-green", "ai-pink", "Ay, hijito, a casita.", false],
      ["ai-green", "ai-blue", "Ay, hijito, a casita.", true],
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
    expect(checkQuality("Ay, hijita, qué poca vergüenza.", say("ai-green", "ai-pink", reply))).toBeNull();
    expect(checkQuality("Ay, hijita, qué poca vergüenza.", say("ai-green", "ai-blue", reply))).toMatchObject({ reason: GENDER, term: "hijita (Chispa: masculino)" });
  });

  it("no cuentan los plurales, los apelativos neutros, los usos que no son vocativos ni la victoria sin rival", () => {
    for (const rival of ["ai-pink", "ai-blue", "ai-purple"]) {
      for (const text of ["Despacito, hijos, que esto es largo.", "Ay, cariño, a casita.", "Perdona, cielo, es el juego.", "El dado te ha querido hoy.", "Qué bonita jugada.", "Mi nieta juega así.", "Una hija de la suerte, eso es lo que eres."]) {
        expect(checkQuality(text, say("ai-green", rival)), `${rival}: ${text}`).toBeNull();
      }
    }
    // Sin rival no hay destinatario con el que comparar: «Ay, hijo» es una interjección.
    expect(checkQuality("¡Gané, hijita! Despacito se llega lejos.", say("ai-green", null, { kind: "victory_win", trigger: "victory" }))).toBeNull();
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
    for (const text of ["¡He ganado la partida!", "¡Gané! La partida es mía.", "¡Meta! El dado me quiere y la partida ya es mía.", "¡Primero en llegar!"]) {
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
      "¿Qué racha de suerte con el dado, eh?",
      "Menuda racha con el dado.",
      "Dos seises seguidos.",
      "¡Dos seises seguidos!",
      "dos seises seguidos",
      "¿Dos seises seguidos?",
      "Tres tiradas seguidas sin sacar nada.",
      "El dado no está de mi parte.",
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
      ["Me he quedado sin ficha de golpe, Brava.", chispaLament],
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
    for (const text of ["¡Te comí, Chispa!", "Me comiste, Brava.", "Golpe de suerte con el dado.", "Me he quedado sin ficha de golpe.", "Por favor, Brava, no corras tanto."]) {
      expect(hasDiscardedExpression(text), text).toBe(false);
    }
    for (const c of CHARACTERS) {
      for (const lines of Object.values(c.chat.lines)) for (const line of lines) expect(hasDiscardedExpression(line), `${c.name}: ${line}`).toBe(false);
    }
  });
});
