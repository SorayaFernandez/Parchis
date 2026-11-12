import { describe, expect, it } from "vitest";
import type { Utterance } from "../../director";
import type { RecentText } from "../../writer";
import { ChatLlmError, cleanLlmText, INVALID_RESPONSE_REASONS } from "../gatewayWriter";
import { COMMENTATOR, OTHER_GAMES, QUALITY_REASONS, SPORTS_METAPHORS, checkQuality } from "../quality";

const say = (speaker: string, rival: string | null, extra: Partial<Utterance> = {}, recent: RecentText[] = []) => ({
  utterance: { speaker, kind: "capture_boast", rival, trigger: "capture", replyTo: null, important: true, ...extra } as Utterance,
  recent,
  replyToText: null,
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
    ok("¡Chas! Me has pillado con la racha mala. Un paso atrás para la Chispa.", say("ai-blue", "ai-pink", { kind: "capture_lament", trigger: "capture_streak", replyTo: 0 }));
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
    expect(checkQuality("¡Llevo tres seguidas!", say("ai-pink", "ai-blue", { kind: "streak_boast", trigger: "capture_streak" }))).toBeNull();
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

  it("los motivos nuevos están en la lista cerrada que se registra", () => {
    for (const reason of QUALITY_REASONS) expect(INVALID_RESPONSE_REASONS).toContain(reason);
  });
});
