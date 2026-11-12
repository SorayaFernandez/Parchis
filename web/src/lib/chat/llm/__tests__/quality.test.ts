import { describe, expect, it } from "vitest";
import type { Utterance } from "../../director";
import type { RecentText } from "../../writer";
import { ChatLlmError, cleanLlmText, INVALID_RESPONSE_REASONS } from "../gatewayWriter";
import { COMMENTATOR, OTHER_GAMES, QUALITY_REASONS, SPORTS_METAPHORS, checkQuality } from "../quality";

const say = (speaker: string, rival: string | null, extra: Partial<Utterance> = {}, recent: RecentText[] = [], usedCatchphrases?: number[]) => ({
  utterance: { speaker, kind: "capture_boast", rival, trigger: "capture", replyTo: null, important: true, ...extra } as Utterance,
  recent,
  replyToText: null,
  ...(usedCatchphrases ? { usedCatchphrases } : {}),
});
type Request = ReturnType<typeof say>;

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
    ok("Ay, mi niña, con dos seguidas ya es castigo divino. Quien mucho abarca, poco aprieta.", say("ai-green", "ai-blue", badStreak));
    // Réplica (capture_lament) dentro de una racha: «racha» está respaldada por el disparador.
    ok("¡Chas! Me has pillado con la racha mala. Un paso atrás para mí.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }));
    // El original («… para la Chispa») habla de sí misma en tercera persona: ahora se rechaza (regla B).
    expect(reject("¡Chas! Me has pillado con la racha mala. Un paso atrás para la Chispa.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }))?.reason).toBe(
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
    expect(checkQuality("Ay, me has pillado tres veces ya, cariño.", say("ai-green", "ai-blue", lament))).toEqual({ reason: "afirmación no respaldada", term: "cifra 3 (real 2)" });
    // Sin señal de captura en la frase, «veces» no se interpreta como cifra de capturas (límite asumido).
    expect(checkQuality("Ay, tres veces ya, cariño.", say("ai-green", "ai-blue", lament))).toBeNull();
  });

  it("D: fuera de una racha (o en una réplica sin recuento) solo se admite «una captura»", () => {
    expect(checkQuality("¡Una captura limpia, Chispa!", say("ai-pink", "ai-blue"))).toBeNull();
    expect(checkQuality("¡Dos capturas, Chispa!", say("ai-pink", "ai-blue"))).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
    expect(checkQuality("Me has pillado tres veces, Brava.", say("ai-blue", "ai-pink", { kind: "capture_lament" }))).toEqual({
      reason: "afirmación no respaldada",
      term: "cifra 3 (real sin racha)",
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
    expect(checkQuality("¡Mi tercera captura, Chispa!", say("ai-pink", "ai-blue", streakOf(2, true)))?.term).toBe("cifra 3 (real 2)");
    expect(checkQuality("¡Mi tercera captura, Chispa!", say("ai-pink", "ai-blue"))?.term).toBe("cifra 3 (real sin racha)");
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
    // Con señal: son cifras de capturas y, sin racha, no están respaldadas.
    for (const text of ["Me has pillado dos veces, Chispa.", "Me has mandado a casa dos veces, Chispa.", "Por segunda vez me pillas, Chispa."]) {
      expect(checkQuality(text, say("ai-blue", "ai-pink", replyIn("capture"))), text).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
    }
    // Y con una mala racha de 2 que lo respalda, se aceptan.
    expect(checkQuality("Me has pillado dos veces, Chispa.", say("ai-pink", "ai-blue", hunted(2, false)))).toBeNull();
    expect(checkQuality("Por segunda vez me pillas, Chispa.", say("ai-pink", "ai-blue", hunted(2, true)))).toBeNull();
  });

  it("D: la señal de captura es léxica y por frase (sin coincidencias accidentales)", () => {
    // La señal tiene que estar en la MISMA frase.
    expect(checkQuality("Me has pillado, sí. Piénsalo dos veces, Chispa.", say("ai-pink", "ai-blue"))).toBeNull();
    // Palabras que contienen las señales pero no lo son: «capturista», «pillería», «cazuela», «racheado», «acasa».
    for (const text of ["Dos veces lo dijo el capturista, Chispa.", "Dos veces vi esa pillería, Chispa.", "Dos veces probé la cazuela, Chispa.", "Dos veces racheado, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toBeNull();
    }
    // Señales válidas: «capturado», «cazado», «comido», «en poco tiempo», «racha», «seguidas».
    for (const text of ["Dos veces me has capturado, Chispa.", "Dos veces me has cazado, Chispa.", "Dos veces me has comido, Chispa.", "Dos veces en poco tiempo, Chispa.", "Dos veces, qué racha, Chispa."]) {
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
    for (const text of ["¡2ª captura, Chispa!", "¡2º captura, Chispa!", "¡2a captura, Chispa!", "Por 2ª vez me pillas, Chispa."]) {
      expect(checkQuality(text, say("ai-pink", "ai-blue")), text).toEqual({ reason: "afirmación no respaldada", term: "cifra 2 (real sin racha)" });
      expect(checkQuality(text, say("ai-pink", "ai-blue", hunted(2, true))), text).toBeNull();
    }
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
    expect(checkQuality("Me has pillado dos veces seguidas, Chispa.", say("ai-pink", "ai-blue", hunted(2, true)))).toBeNull();
    expect(checkQuality("Me has pillado dos veces seguidas, Chispa.", say("ai-pink", "ai-blue", hunted(3, false)))?.term).toBe("cifra 2 (real 3)");
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

  it("los motivos nuevos están en la lista cerrada que se registra", () => {
    for (const reason of QUALITY_REASONS) expect(INVALID_RESPONSE_REASONS).toContain(reason);
  });
});
