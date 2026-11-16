// Comprobaciones de calidad de los textos del LLM (puras, sin red). Las usa `cleanLlmText` después de
// las comprobaciones de formato, longitud y nombres; si alguna falla, el texto se rechaza y el servicio
// publica la frase local. Devuelven el motivo (texto fijo) y el término de NUESTRO catálogo que ha
// coincidido, para el diagnóstico: nunca el texto del modelo.
//
// Origen: problemas vistos en Preview (partida 707c3c6d…): frase en inglés, «la abuela Brava», «racha»
// en una captura simple, Don Ernesto tuteando, coletillas copiadas, «tres en raya» y «ya casi estás fuera».

import { getCharacter, CHARACTER_NAMES } from "@/lib/game/characters";
import type { ChatTrigger } from "../schemas";
import type { CompleteCaptureFacts, StreakFacts, StreakState } from "../director";
import type { ChatWriteRequest } from "../writer";
import { detectCatchphrases, normalizeText } from "../catchphrases";
import { unbackedPositionClaim, unbackedWinClaim } from "../positionClaims";

export interface QualityIssue {
  reason: QualityReason;
  /** Término del catálogo que ha coincidido (nunca el texto del modelo). */
  term: string;
}

export const QUALITY_REASONS = [
  "idioma no permitido",
  "mezcla nombres de personajes",
  "tutea (Don Ernesto)",
  "expresión característica repetida",
  "expresión ajena al parchís",
  "afirmación no respaldada",
  "habla de sí mismo en tercera persona",
  "demasiadas frases",
  "no concuerda el género del destinatario",
  "expresión poco natural",
  "se dirige a sí mismo",
  "contradice quién captura",
  "no responde a la captura",
  "se nombra a sí mismo",
  "repite el mensaje anterior",
] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];

/** Minúsculas y sin tildes (la «ñ» se conserva). */
export const normalize = normalizeText;

const LETTER = "\\p{L}\\p{N}";
/** Expresión regular de una frase como palabras completas (límites Unicode), sobre texto normalizado. */
const wordsRe = (phrase: string, flags = "u") =>
  new RegExp(`(?<![${LETTER}'])${phrase.split(/\s+/).map(escape).join("\\s+")}(?![${LETTER}'])`, flags);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── 1. Idioma ──────────────────────────────────────────────────────────────────────────────────────

/** Expresiones inglesas inequívocas: basta una. */
const ENGLISH_PHRASES = [
  "who laughs last", "laughs best", "game over", "good luck", "bad luck", "well done", "nice try", "you lose",
  "you win", "i win", "oh my god", "see you", "no way", "my bad", "let's go", "come on", "what the",
];
/** Contracciones inglesas: basta una. */
const ENGLISH_CONTRACTION = /(?<![\p{L}])(?:it's|don't|i'm|you're|can't|won't|that's|let's|isn't|didn't|i'll|we're)(?![\p{L}])/u;
/**
 * Palabras inglesas sin equivalente en español (ni como palabra ni como préstamo habitual). Hacen falta
 * dos distintas: un préstamo suelto no basta. Se excluyen a propósito las ambiguas («no», «me», «a»,
 * «has», «ok», «top», «crack», «show», «fan»…).
 */
const ENGLISH_WORDS = new Set([
  "the", "you", "your", "who", "what", "is", "are", "was", "were", "with", "this", "that", "my", "of", "for",
  "last", "best", "laughs", "laugh", "game", "luck", "lucky", "win", "lose", "good", "bad", "and", "it", "not",
  "home", "again", "next", "time", "now", "today", "never", "always", "here", "there", "they", "we", "she",
]);

function checkLanguage(text: string): QualityIssue | null {
  const t = normalize(text).replace(/[’‘]/g, "'");
  for (const phrase of ENGLISH_PHRASES) if (wordsRe(phrase).test(t)) return { reason: "idioma no permitido", term: phrase };
  const contraction = ENGLISH_CONTRACTION.exec(t);
  if (contraction) return { reason: "idioma no permitido", term: contraction[0] };
  const found = [...new Set(t.match(/[\p{L}]+/gu) ?? [])].filter((w) => ENGLISH_WORDS.has(w));
  return found.length >= 2 ? { reason: "idioma no permitido", term: found.slice(0, 2).join("+") } : null;
}

// ── 2. Nombres: alias y combinaciones cruzadas ─────────────────────────────────────────────────────

/** Alias de cada personaje (además del nombre completo, que ya comprueba `cleanLlmText`). */
export const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Don Ernesto": ["ernesto"],
  "Abuela Pilar": ["pilar"],
};
/** Palabra propia del nombre de cada personaje (para las combinaciones cruzadas). */
const NAME_WORDS: Readonly<Record<string, string>> = { Brava: "brava", "Don Ernesto": "ernesto", "Abuela Pilar": "pilar", Chispa: "chispa" };
/** Tratamientos que solo corresponden a un personaje: «abuela X» solo con Pilar, «don X» solo con Ernesto. */
const TITLES: Readonly<Record<string, string>> = { abuela: "Abuela Pilar", don: "Don Ernesto", "doña": "" };

/**
 * «abuela» se refiere a Abuela Pilar cuando el contexto la identifica: con artículo definido o como
 * vocativo («la abuela», «¡Abuela!», «abuela,»). No cuando es genérica («mi abuela», «una abuela»,
 * «como abuela»).
 */
const GENERIC_BEFORE_ABUELA = new Set(["mi", "tu", "su", "mis", "tus", "sus", "nuestra", "vuestra", "una", "unas", "otra", "cualquier", "como", "de"]);

function abuelaRefersToPilar(text: string): boolean {
  const t = normalize(text);
  for (const match of t.matchAll(/(?<![\p{L}\p{N}])abuela(?![\p{L}\p{N}])/gu)) {
    const before = t.slice(0, match.index).match(/([\p{L}]+)[^\p{L}]*$/u)?.[1];
    if (!before || !GENERIC_BEFORE_ABUELA.has(before)) return true;
  }
  return false;
}

/** Personajes que el texto nombra por un alias (no por el nombre completo). */
function aliasMentions(text: string): { name: string; alias: string }[] {
  const t = normalize(text);
  const found: { name: string; alias: string }[] = [];
  for (const [name, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) if (wordsRe(alias).test(t)) found.push({ name, alias });
  }
  if (abuelaRefersToPilar(text)) found.push({ name: "Abuela Pilar", alias: "abuela" });
  return found;
}

/** «la abuela Brava», «don Chispa»…: un tratamiento delante del nombre de otro personaje. */
function crossedName(text: string): QualityIssue | null {
  const t = normalize(text);
  for (const [title, owner] of Object.entries(TITLES)) {
    for (const [name, word] of Object.entries(NAME_WORDS)) {
      if (name === owner) continue;
      if (wordsRe(`${title} ${word}`).test(t)) return { reason: "mezcla nombres de personajes", term: `${title} ${word}` };
    }
  }
  return null;
}

/** Nombre del catálogo mencionado por alias que no participa en la intervención, si lo hay. */
export function foreignAlias(text: string, allowed: ReadonlySet<string>): { name: string; alias: string } | null {
  return aliasMentions(text).find((m) => !allowed.has(m.name)) ?? null;
}

// ── 4. Don Ernesto trata de usted ──────────────────────────────────────────────────────────────────

const USTED_SPEAKER = "ai-purple";
/** Marcas de tuteo inequívocas (segunda persona informal). */
const TUTEO = ["tú", "tu", "tus", "ti", "te", "contigo", "eres", "estás", "tienes", "has", "vas", "puedes", "quieres", "sabes", "juegas", "mueves"];

/** Quita las citas (entre comillas o tras «dice:», «decía:»…): en ellas habla otro, no Don Ernesto. */
function withoutQuotes(text: string): string {
  return text
    .replace(/«[^»]*»|"[^"]*"|“[^”]*”|‘[^’]*’/g, " ")
    .replace(/\b(?:dice|dijo|decía|diría|dicen|reza)\s*:[\s\S]*$/iu, " ");
}

/** Presente de «tú» de verbos de la partida (Don Ernesto diría «tira», «saca», «come»…). */
const TUTEO_PRESENT = ["tiras", "sacas", "comes", "pierdes", "llevas", "sales", "llegas", "dejas", "corres", "vienes", "haces", "dices", "necesitas", "piensas", "crees", "pillas"];
/**
 * Pretérito de «tú» («tiraste», «sacaste», «comiste», «pillaste»): termina en -aste o -iste. Se excluyen las
 * palabras que no lo son («existe», «insiste», «triste», «chiste», «contraste»…).
 */
const TUTEO_PRETERITE = /(?<![\p{L}])(\p{L}+(?:aste|iste))(?![\p{L}])/gu;
const NOT_PRETERITE = new Set(["existe", "consiste", "insiste", "resiste", "asiste", "subsiste", "persiste", "desiste", "embiste", "reviste", "triste", "chiste", "alpiste", "contraste", "desgaste", "gaste", "baste", "caste"]);

function checkUsted(text: string, speaker: string): QualityIssue | null {
  if (speaker !== USTED_SPEAKER) return null;
  // Con tildes: «estás» es tuteo, pero «estas» (demostrativo) no.
  const t = withoutQuotes(text).toLowerCase();
  for (const word of [...TUTEO, ...TUTEO_PRESENT]) {
    if (wordsRe(word).test(t)) return { reason: "tutea (Don Ernesto)", term: word };
  }
  for (const m of t.matchAll(TUTEO_PRETERITE)) {
    if (!NOT_PRETERITE.has(m[1])) return { reason: "tutea (Don Ernesto)", term: m[1] };
  }
  return null;
}

// ── 5. Coletillas repetidas ────────────────────────────────────────────────────────────────────────

/**
 * Coletilla repetida: el texto contiene una coletilla de quien habla (al inicio de una frase, con o sin
 * palabras detrás; ver `catchphrases.ts`) que ese personaje ya usó en la partida (`usedCatchphrases`,
 * el registro del director) o en sus textos recientes. Si la dijo otro personaje, no cuenta.
 */
function checkRepeatedCatchphrase(text: string, request: ChatWriteRequest): QualityIssue | null {
  const speaker = request.utterance.speaker;
  const character = getCharacter(speaker);
  if (!character) return null;
  const used = new Set(request.usedCatchphrases ?? []);
  for (const r of request.recent) if (r.speaker === speaker) for (const index of detectCatchphrases(speaker, r.text)) used.add(index);
  const repeated = detectCatchphrases(speaker, text).find((index) => used.has(index));
  return repeated === undefined ? null : { reason: "expresión característica repetida", term: character.catchphrases[repeated] };
}

// ── 6. Ajeno al parchís y afirmaciones sin respaldo ────────────────────────────────────────────────

/** Reglas o situaciones de otros juegos y deportes: prohibidas para todos. */
export const OTHER_GAMES = [
  // «jaque mate» antes que «jaque», para que el diagnóstico informe del término más específico.
  "tres en raya", "jaque mate", "jaque", "ajedrez", "fuera de juego", "penalti", "tarjeta roja", "tarjeta amarilla",
  "naipes", "baraja", "ruleta", "bingo", "domino", "la oca", "poker", "mus", "home run", "strike",
];
/**
 * Metáforas deportivas («¡Golazo por la escuadra!»): prohibidas para todos, también para Chispa (antes se le
 * permitían como «comentarista»; ya no lo es). «gol» incluye sus derivados (goles, golazo, goleada…).
 */
export const SPORTS_METAPHORS = ["gol", "golazo", "por la escuadra", "triple", "canasta", "futbol", "baloncesto", "tenis"];

/** Derivados de «gol» como palabra completa (no «golpe», «golosina» ni «golondrina»). */
const GOAL_WORDS = /(?<![\p{L}])gol(?:es|azos?|ito|eada|eadas|ear|ea|eo|eamos|eador|eadora|eadores)?(?![\p{L}])/u;
/** Un término de otro juego o deporte como palabra o expresión completa; si es una sola palabra, también en plural. */
const gameTermRe = (term: string) => (/\s/.test(term) ? wordsRe(term) : new RegExp(`(?<![${LETTER}])${escape(term)}(?:s|es)?(?![${LETTER}])`, "u"));
/** Primer término de otros juegos o deportes que aparece en el texto (ya normalizado), o `null`. */
function gameTerm(t: string): string | null {
  for (const term of OTHER_GAMES) if (gameTermRe(term).test(t)) return term;
  if (GOAL_WORDS.test(t)) return "gol";
  for (const term of SPORTS_METAPHORS) if (gameTermRe(term).test(t)) return term;
  return null;
}

const STREAK_TRIGGERS: ReadonlySet<ChatTrigger> = new Set(["capture_streak", "bad_streak"]);

/**
 * Afirmaciones sobre la marcha de la partida que nunca se respaldan. «Voy ganando», «voy perdiendo» y sus
 * equivalentes (también dichos del rival) no están aquí: se comprueban con la clasificación real en
 * `unbackedPositionClaim` (`positionClaims.ts`).
 */
const STATE_CLAIMS: readonly RegExp[] = [
  // Eliminación (en el parchís nadie queda «fuera»).
  /(?<![\p{L}])(?:estas|esta|estais|estan|quedas|queda|quedais)\s+(?:ya\s+)?(?:casi\s+)?(?:fuera|eliminad[oa]s?)(?![\p{L}])/u,
  /(?<![\p{L}])(?:casi\s+fuera|fuera\s+de\s+la\s+partida|eliminad[oa]s?)(?![\p{L}])/u,
  // Posición en la partida («voy ganando», «vas el último», «eres el último»), pero no «es la primera
  // vez» ni «va la primera ficha».
  /(?<![\p{L}])(?:vas|va|voy|vais|van|vamos)\s+(?:el\s+|la\s+)?(?:ultim[oa]|primer[oa]|en\s+cabeza|(?:por\s+)?delante|a\s+la\s+cola)(?![\p{L}])(?!\s+(?:vez|ficha|fichas|casilla|tirada|en\s+\p{L}+))/u,
  // «Por detrás de alguien» es relativo: no se puede comprobar con la clasificación.
  /(?<![\p{L}])(?:vas|va|voy|vais|van|vamos|estoy|estas|esta)\s+(?:muy\s+)?por\s+detras\s+de(?![\p{L}])/u,
  /(?<![\p{L}])(?:eres|es|soy|sois)\s+(?:el|la)\s+ultim[oa](?![\p{L}])(?!\s+(?:vez|ficha|fichas|casilla|tirada|en\s+\p{L}+))/u,
  /(?<![\p{L}])(?:farolillo\s+rojo|en\s+cabeza|a\s+punto\s+de\s+(?:ganar|perder|terminar|acabar))(?![\p{L}])/u,
];
/**
 * Afirmar el resultado de la partida: solo en la victoria. «ganado» cuenta si cierra la frase o va con
 * «la partida»; «perdido», solo con «la partida» («has perdido una ficha» es un hecho de la captura).
 */
const RESULT_CLAIM =
  /(?<![\p{L}])(?:he|has|ha|hemos|habeis|han)\s+(?:ganado(?:\s+la\s+partida)?(?=\s*(?:$|[!.?,;…])|\s+la\s+partida)|perdido\s+la\s+partida)/u;
/** Hablar de rachas o de capturas seguidas: solo con una racha que lo respalde (`hasStreakContext`). */
const STREAK_CLAIM = /(?<![\p{L}])(?:racha|rachas|seguidas|seguidos|consecutivas|consecutivos)(?![\p{L}])/gu;

/**
 * Primera palabra de racha («racha», «seguidas»…) que afirma algo sobre capturas, o `null`. No cuentan las
 * menciones coloquiales de la suerte o del dado (`isLuckMention`) ni «seguidos» detrás de una palabra
 * del dado («dos seises seguidos»).
 */
function unsupportedStreakWord(t: string, request: ChatWriteRequest): string | null {
  for (const piece of t.matchAll(/[^.!?;:…]+[.!?;:…]*/gu)) {
    const sentence = piece[0];
    for (const m of sentence.matchAll(STREAK_CLAIM)) {
      const start = m.index ?? 0;
      if (m[0].startsWith("racha")) {
        const mention = [...sentence.matchAll(MENTION)].find((x) => (x.index ?? 0) <= start && start < (x.index ?? 0) + x[0].length);
        if (mention && isLuckMention(sentence, mention, request, t)) continue;
      } else if (isDiceSequence(sentence, start, t)) {
        continue;
      }
      return m[0];
    }
  }
  return null;
}

function checkGameTalk(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  const game = gameTerm(t);
  if (game) return { reason: "expresión ajena al parchís", term: game };
  if (!hasStreakContext(request)) {
    const term = unsupportedStreakWord(t, request);
    if (term) return { reason: "afirmación no respaldada", term };
  }
  for (const re of STATE_CLAIMS) {
    const match = re.exec(t);
    if (match) return { reason: "afirmación no respaldada", term: match[0].replace(/\s+/g, " ") };
  }
  // «Voy ganando», «voy perdiendo» y equivalentes, también del rival: solo con la clasificación real.
  const position = unbackedPositionClaim(text, request);
  if (position) return { reason: "afirmación no respaldada", term: position };
  // «No me extraña que Brava gane» y equivalentes: solo si ese rival ya ha ganado de verdad.
  const win = unbackedWinClaim(text, request);
  if (win) return { reason: "afirmación no respaldada", term: win };
  const result = RESULT_CLAIM.exec(t);
  if (result && request.utterance.trigger !== "victory") return { reason: "afirmación no respaldada", term: result[0].replace(/\s+/g, " ") };
  return null;
}

// ── Hablar de sí mismo en tercera persona ──────────────────────────────────────────────────────────

/**
 * Nombres y alias con los que un personaje podría nombrarse a sí mismo. «la abuela» no está para Pilar:
 * hablar de sí misma como «la abuela» es parte de su personaje (sus frases locales lo usan: «La abuela
 * también sabe»).
 */
const SELF_NAMES: Readonly<Record<string, readonly string[]>> = {
  "ai-pink": ["brava"],
  "ai-purple": ["don ernesto", "ernesto"],
  "ai-green": ["abuela pilar", "pilar"],
  "ai-blue": ["chispa"],
};
/**
 * El propio nombre (o alias) como destinatario: un vocativo al principio de la frase o entre signos
 * («He comido su ficha, Don Ernesto.», «Pues nada, Don Ernesto, …», «Chispa, ¡qué suerte!» dicho por
 * Chispa). Nadie se habla a sí mismo: se nombra, si acaso, al rival. (Cualquier otra mención del propio
 * nombre la rechaza `checkOwnName`.)
 */
function checkSelfAddress(text: string, speaker: string): QualityIssue | null {
  const t = normalize(text);
  for (const name of SELF_NAMES[speaker] ?? []) {
    const re = new RegExp(String.raw`(?:^|[,;:.!?¡¿…—-])\s*(?:(?:oye|mira|ay|venga|pues|pues nada|vamos)\s*,?\s*)?${name.replace(/\s+/g, "\\s+")}\s*(?:[,;:.!?…—-]|$)`, "u");
    if (re.test(t)) return { reason: "se dirige a sí mismo", term: name };
  }
  return null;
}

/**
 * Verbos y partículas en tercera persona que, justo después del propio nombre, forman una frase sobre
 * sí mismo («Chispa ha caído», «Brava nunca falla»). Solo construcciones inequívocas.
 */
const THIRD_PERSON =
  "(?:ha|va|esta|es|sigue|gana|pierde|se|no|nunca|siempre|tiene|puede|vuelve|lleva|manda|captura|cae|falla|sabe|quiere|juega|avanza|viene|dice|presume|celebra|lamenta)";

/** Verbos de habla de un narrador (sin tildes, tras `normalize`): «dijo Pilar», «Chispa responde». */
const SPEECH_VERBS =
  "(?:dijo|dice|decia|comenta|comento|responde|respondio|contesta|contesto|exclama|exclamo|añade|añadio|murmura|murmuro|grita|grito|suspira|suspiro|replica|replico)";

/**
 * El personaje se nombra a sí mismo en tercera persona:
 * - Con artículo o contracción: «la Chispa», «al Ernesto», «la Pilar».
 * - Su nombre seguido de un verbo en tercera persona: «Chispa ha caído», «Don Ernesto nunca se equivoca».
 * Nombrar a los rivales se permite. Las demás menciones del propio nombre las rechaza `checkOwnName`.
 */
function checkSelfThirdPerson(text: string, speaker: string): QualityIssue | null {
  const t = normalize(text);
  for (const name of SELF_NAMES[speaker] ?? []) {
    const words = name.split(/\s+/).map(escape).join("\\s+");
    // Artículo o contracción («al», «del»); «de» no («¡Gol de Chispa!»).
    const withArticle = new RegExp(`(?<![${LETTER}])(?:el|la|al|del)\\s+${words}(?![${LETTER}])`, "u");
    if (withArticle.test(t)) return { reason: "habla de sí mismo en tercera persona", term: `artículo+${name}` };
    const withVerb = new RegExp(`(?<![${LETTER}])${words}\\s+${THIRD_PERSON}(?![${LETTER}])`, "u");
    if (withVerb.test(t)) return { reason: "habla de sí mismo en tercera persona", term: `${name}+verbo` };
    // Narración de su propia frase: «…, dijo Pilar», «dice Chispa», «Brava dijo».
    const narrated = new RegExp(
      `(?<![${LETTER}])(?:${SPEECH_VERBS}\\s+${words}|${words}\\s+${SPEECH_VERBS})(?![${LETTER}])`,
      "u",
    );
    if (narrated.test(t)) return { reason: "habla de sí mismo en tercera persona", term: `narración+${name}` };
  }
  return null;
}

/**
 * El personaje nombra su propio nombre o alias, en cualquier construcción: se presenta («Soy Don Ernesto y le
 * he comido la ficha a Abuela Pilar», «Le habla Don Ernesto»), se jalea («¡Gol de Chispa!») o se cita. Nadie
 * dice su propio nombre en una partida en casa. Pilar sí puede llamarse «la abuela» (no es su nombre: ver
 * `SELF_NAMES`). «Brava» y «Chispa» solo cuentan con mayúscula, para no confundirlas con el adjetivo o la
 * palabra común («¡Qué brava!», «una chispa de suerte»).
 */
function checkOwnName(text: string, speaker: string): QualityIssue | null {
  for (const name of SELF_NAMES[speaker] ?? []) {
    const words = name.split(/\s+/).map(escape).join("\\s+");
    const re = new RegExp(`(?<![${LETTER}])${words}(?![${LETTER}])`, "giu");
    const common = name === "brava" || name === "chispa";
    // Sin tildes y sin distinguir mayúsculas, salvo «Brava»/«Chispa», que deben empezar por mayúscula.
    const found = common ? [...text.matchAll(re)].some((m) => /^\p{Lu}/u.test(m[0])) : re.test(normalize(text));
    if (found) return { reason: "se nombra a sí mismo", term: name };
  }
  return null;
}

// ── Cifras de capturas ─────────────────────────────────────────────────────────────────────────────

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1, una: 1, uno: 1, dos: 2, "un par de": 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30,
  cuarenta: 40, cincuenta: 50,
};
/** Ordinales (sin tildes, tras `normalize`): «la tercera captura», «por segunda vez». */
const ORDINALS: Readonly<Record<string, number>> = {
  primera: 1, primer: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercer: 3, tercero: 3, cuarta: 4, cuarto: 4,
  quinta: 5, quinto: 5, sexta: 6, sexto: 6, septima: 7, setima: 7, octava: 8, novena: 9, decima: 10,
};
/** Cifras en número o en palabra (sin tildes; de las más largas a las más cortas). Las capturas de la ventana no pasan de 50. */
const NUMBER = ["\\d+", ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)].join("|");
const STREAK_WORDS = "seguidas|seguidos|consecutivas|consecutivos";
/** Palabras de tiempo o turno: «en dos turnos capturas otra» usa «capturas» como verbo, no como cifra. */
const TIME_WORDS = new Set(["turnos", "tiradas", "rondas", "jugadas", "minutos", "segundos", "movimientos", "vueltas", "partidas"]);
/** Tras el verbo «capturas» suele venir su complemento («capturas otra», «capturas mi ficha»). */
const VERB_OBJECT = "otra|otras|una|uno|esa|esas|esta|estas|mi|mis|tu|tus|su|sus|la|las|el|los";

/**
 * Señales léxicas de que una frase habla de capturas (palabras completas). Hacen falta para que «veces»
 * o «vez» cuenten como cifra de capturas: «Me has pillado dos veces» sí, «Piénsalo dos veces» no.
 */
const CAPTURE_CONTEXT = new RegExp(
  "(?<![\\p{L}])(?:captur(?:a|as|o|e|es|ado|ada|ados|adas|ar|aste|amos|an)|pill(?:a|as|o|e|es|ado|ada|ados|adas|ar|aste)|" +
    "caz(?:a|as|o|ado|ada|ados|adas|ar|aste)|comidos?|a\\s+casa|en\\s+poco\\s+tiempo|rachas?|" +
    STREAK_WORDS +
    ")(?![\\p{L}])",
  "u",
);

/**
 * Afirmaciones sobre cuántas capturas lleva alguien, dentro de una frase:
 * - Cifra (en número o en palabra) seguida de «captura(s)», «veces», «seguidas/os» o «consecutivas/os».
 *   Con «capturas» se admite una palabra en medio («tres buenas capturas»), salvo que sea de tiempo o
 *   turno, o que «capturas» lleve complemento (entonces es el verbo: «en dos turnos capturas otra»).
 * - «doble captura» (2) y «triple captura» (3).
 * - Ordinal en palabra o en cifra («la tercera captura», «por segunda vez», «2ª captura», «3º captura»).
 * «veces» y «vez» solo cuentan si la frase tiene una señal de captura (`CAPTURE_CONTEXT`).
 */
const CARDINAL = new RegExp(`(?<![\\p{L}\\p{N}])(${NUMBER})\\s+(capturas?|veces|vez|${STREAK_WORDS})(?![\\p{L}])`, "gu");
/**
 * Fichas capturadas: «me has comido tres fichas», «te he mandado dos de tus fichas a casa». Solo cuentan
 * si las rige un verbo de captura (ver `checkCountClaims`): «dos fichas en casa» no es una cifra.
 */
const FICHAS = new RegExp(`(?<![\\p{L}\\p{N}])(${NUMBER})\\s+(?:de\\s+(?:mis|tus|sus)\\s+)?(fichas?)(?![\\p{L}])`, "gu");
/**
 * Cifras sin sustantivo tras «van», «llevo», «llevas», «son»…, al final de la frase o antes de una
 * coma, «y», «ya» o un ritmo: «¡Ya van tres!», «Ya llevo dos en poco tiempo». Se tratan como cifras de
 * capturas (no se cuentan si sigue un sustantivo: «llevo dos fichas en la meta»).
 */
const NOUNLESS = new RegExp(
  `(?<![\\p{L}])(?:van|llevo|llevas|lleva|llevamos|llevais|llevan|son)\\s+(?:ya\\s+)?(?:solo\\s+)?(${NUMBER})(?=\\s*(?:$|[,¡!¿?…]|(?:y|ya)(?![\\p{L}])|en\\s+poco\\s+tiempo|seguid|consecutiv))`,
  "gu",
);
/** «una vez» en expresiones hechas que no cuentan nada: «una vez más», «de una vez», «por una vez», «una vez que». */
const ONCE_IDIOM_BEFORE = /(?:^|[^\p{L}])(?:de|por|alguna|otra|a\s+la)\s+$/u;
const ONCE_IDIOM_AFTER = /^\s+(?:mas|que)(?![\p{L}])/u;
const CARDINAL_GAP = new RegExp(
  `(?<![\\p{L}\\p{N}])(${NUMBER})\\s+(\\p{L}+)\\s+(capturas)(?![\\p{L}])(?!\\s+(?:${VERB_OBJECT})(?![\\p{L}]))`,
  "gu",
);
const MULTIPLE = /(?<![\p{L}])(doble|triple)\s+(capturas?)(?![\p{L}])/gu;
const ORDINAL_WORD = new RegExp(`(?<![\\p{L}])(${Object.keys(ORDINALS).join("|")})\\s+(captura|vez)(?![\\p{L}])`, "gu");
const ORDINAL_DIGIT = /(?<![\p{L}\p{N}])(\d+)(?:ª|º|°|era|er|ero|a|o)\s+(captura|vez)(?![\p{L}])/gu;
const STREAK_WORD = new RegExp(`(?<![\\p{L}])(${STREAK_WORDS})(?![\\p{L}])`, "u");
const STREAK_WORD_ALL = new RegExp(STREAK_WORD.source, "gu");
/**
 * Palabra del dado justo delante de «seguidos/as» o «consecutivos/as» (sin tildes, tras `normalize`):
 * «dos seises seguidos», «tres tiradas seguidas». Habla del dado, no de capturas seguidas, así que no se
 * compara con ninguna racha (no se puede verificar con los hechos de captura).
 */
const DICE_BEFORE = /(?<![\p{L}])(?:seises|cincos|unos|doses|treses|cuatros|dados?|tiradas?)\s+$/u;
/**
 * «seguidos» detrás de una palabra del dado, y sin vocabulario de capturas en TODO el texto (`text`,
 * normalizado): «Te he capturado en dos tiradas seguidas» o «Dos tiradas seguidas comiéndote» afirman
 * capturas seguidas y se comprueban como tales.
 */
const isDiceSequence = (sentence: string, start: number, text: string) => DICE_BEFORE.test(sentence.slice(0, start)) && !CAPTURE_VOCAB.test(text);
/** Disparadores en los que acaba de haber una captura (no la victoria). */
const CAPTURE_TRIGGERS: ReadonlySet<ChatTrigger> = new Set(["capture", "capture_streak", "bad_streak"]);

/** Una cifra de capturas de una frase, con su posición (para saber de quién habla). */
interface CountClaim {
  n: number;
  /** Sustantivo contado («capturas», «veces», «fichas»…); vacío en las cifras sin sustantivo. */
  noun: string;
  /** Artículo indefinido («una captura», «una ficha»), no un ordinal: puede ser la captura de ahora. */
  indefinite?: boolean;
  start: number;
  end: number;
}

/** Cifras de capturas de una frase (sin signos de fin de frase). */
function countClaimsIn(sentence: string): CountClaim[] {
  const claims: CountClaim[] = [];
  const value = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]);
  const at = (m: RegExpMatchArray) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  const indefinite = (raw: string) => raw === "un" || raw === "una" || raw === "uno";
  for (const m of sentence.matchAll(CARDINAL)) {
    // «una vez más», «de una vez», «por una vez», «una vez que»: expresiones hechas, no cifras.
    const idiom = m[2] === "vez" && value(m[1]) === 1 && (ONCE_IDIOM_BEFORE.test(sentence.slice(0, m.index)) || ONCE_IDIOM_AFTER.test(sentence.slice((m.index ?? 0) + m[0].length)));
    if (!idiom) claims.push({ n: value(m[1]), noun: m[2], indefinite: indefinite(m[1]) && m[2] !== "vez", ...at(m) });
  }
  for (const m of sentence.matchAll(FICHAS)) claims.push({ n: value(m[1]), noun: m[2], indefinite: indefinite(m[1]), ...at(m) });
  for (const m of sentence.matchAll(NOUNLESS)) claims.push({ n: value(m[1]), noun: "", ...at(m) });
  for (const m of sentence.matchAll(CARDINAL_GAP)) if (!TIME_WORDS.has(m[2])) claims.push({ n: value(m[1]), noun: m[3], indefinite: indefinite(m[1]), ...at(m) });
  for (const m of sentence.matchAll(MULTIPLE)) claims.push({ n: m[1] === "doble" ? 2 : 3, noun: m[2], ...at(m) });
  for (const m of sentence.matchAll(ORDINAL_WORD)) claims.push({ n: ORDINALS[m[1]], noun: m[2], ...at(m) });
  for (const m of sentence.matchAll(ORDINAL_DIGIT)) claims.push({ n: Number(m[1]), noun: m[2], ...at(m) });
  // «veces» / «vez» sin señal de captura en la frase: no hablan de capturas («Piénsalo dos veces»).
  const aboutCaptures = CAPTURE_CONTEXT.test(sentence);
  return claims.filter((c) => aboutCaptures || (c.noun !== "veces" && c.noun !== "vez"));
}

// ── Atribución de las cifras ───────────────────────────────────────────────────────────────────────

/**
 * De qué recuento habla una cifra: de una pareja en una dirección, de las capturas hechas o recibidas
 * por alguien, o de su racha o mala racha (que puede estar recién interrumpida).
 */
type CountScope =
  | "selfMadeSinceBreak"
  | "rivalMadeSinceBreak"
  | "selfReceivedSinceBreak"
  | "rivalReceivedSinceBreak"
  | "selfOnRival"
  | "rivalOnSelf"
  | "selfMade"
  | "rivalMade"
  | "selfReceived"
  | "rivalReceived"
  | "selfStreak"
  | "rivalStreak"
  | "selfBad"
  | "rivalBad";

/** Texto fijo del diagnóstico para cada recuento (nunca el texto del modelo). */
const SCOPE_LABELS: Readonly<Record<CountScope, string>> = {
  selfMadeSinceBreak: "hechas por quien habla desde que le capturaron",
  rivalMadeSinceBreak: "hechas por el rival desde que le capturaron",
  selfReceivedSinceBreak: "recibidas por quien habla desde que capturó",
  rivalReceivedSinceBreak: "recibidas por el rival desde que capturó",
  selfOnRival: "de quien habla al rival",
  rivalOnSelf: "del rival a quien habla",
  selfMade: "hechas por quien habla",
  rivalMade: "hechas por el rival",
  selfReceived: "recibidas por quien habla",
  rivalReceived: "recibidas por el rival",
  selfStreak: "racha de quien habla",
  rivalStreak: "racha del rival",
  selfBad: "mala racha de quien habla",
  rivalBad: "mala racha del rival",
};

/** Participios de capturar (y «volver a» + infinitivo): «capturado», «pillada», «mandado a casa». */
const PERFECT =
  "(?:vuelto\\s+a\\s+(?:capturar|pillar|cazar|comer|mandar)|(?:capturad|pillad|cazad|comid)[oa]s?|(?:mandad|devuelt|enviad)[oa]s?(?=(?:\\s+[\\p{L}\\p{N}]+){0,4}?\\s+a\\s+casa))";
const BAD_SUFFIX = "(?:mala|negra|adversa|de\\s+mala\\s+suerte)";
const cue = (source: string) => new RegExp(`(?<![\\p{L}])(?:${source})(?![\\p{L}])`, "gu");
/**
 * Señales gramaticales del sujeto y el objeto de una cifra, en orden de prioridad (las de pareja, antes
 * que las generales). Quien habla es la primera persona; su rival, la segunda o la tercera (Don Ernesto
 * trata de usted, y en una intervención solo se nombra al rival).
 */
const SCOPE_CUES: readonly [CountScope, RegExp, boolean][] = [
  // Tramo desde la última interrupción («desde entonces llevas una»), antes que los generales.
  ["selfMadeSinceBreak", cue(`desde\\s+entonces\\s+(?:solo\\s+)?(?:llevo|he\\s+${PERFECT})`), false],
  ["rivalMadeSinceBreak", cue(`desde\\s+entonces\\s+(?:solo\\s+)?(?:llevas|lleva|(?:has|ha)\\s+${PERFECT})`), false],
  ["selfReceivedSinceBreak", cue(`desde\\s+entonces\\s+(?:solo\\s+)?me\\s+han\\s+${PERFECT}`), true],
  ["rivalReceivedSinceBreak", cue(`desde\\s+entonces\\s+(?:solo\\s+)?(?:te|le)\\s+han\\s+${PERFECT}`), true],
  ["rivalOnSelf", cue(`me\\s+(?:has|ha)\\s+${PERFECT}|me\\s+(?:capturas|pillas|cazas|comes|captura|pilla|caza|come)`), true],
  ["selfOnRival", cue(`(?:te|le|la|lo|os)\\s+(?:he|hemos)\\s+${PERFECT}|te\\s+(?:capturo|pillo|cazo|como)|(?:le|la|lo)\\s+(?:capturo|pillo|cazo)|(?:capturo|pillo|cazo)\\s+a`), true],
  ["selfReceived", cue(`me\\s+(?:han|habeis)\\s+${PERFECT}|me\\s+(?:capturan|pillan|cazan|comen)`), true],
  ["rivalReceived", cue(`(?:te|le|os)\\s+han\\s+${PERFECT}|(?:te|le)\\s+(?:capturan|pillan|cazan|comen)`), true],
  ["selfBad", cue(`mi\\s+(?:mala\\s+racha|racha\\s+${BAD_SUFFIX})`), false],
  ["rivalBad", cue(`(?:tu|su)\\s+(?:mala\\s+racha|racha\\s+${BAD_SUFFIX})`), false],
  ["selfStreak", cue(`mi\\s+racha(?!\\s+${BAD_SUFFIX})`), false],
  ["rivalStreak", cue(`(?:tu|su)\\s+racha(?!\\s+${BAD_SUFFIX})`), false],
  ["selfMade", cue(`(?<!(?:me|te|le|la|lo|os)\\s)(?:he|hemos)\\s+${PERFECT}`), true],
  // «Ya me he comido tres fichas»: el «me» enfático no cambia el sujeto (las ha comido quien habla).
  ["selfMade", cue(`me\\s+(?:he|hemos)\\s+comido`), true],
  ["selfMade", cue(`llevo|(?<!(?:me|te|le|la|lo|os)\\s)(?:he|hemos)\\s+hecho|mis?\\s+(?:\\p{L}+\\s+)?capturas?`), false],
  ["rivalMade", cue(`(?<!(?:me|te|le|la|lo|os)\\s)(?:has|ha)\\s+${PERFECT}`), true],
  ["rivalMade", cue(`llevas|lleva|(?<!(?:me|te|le|la|lo|os)\\s)(?:has|ha)\\s+hecho|(?:tus?|sus?)\\s+(?:\\p{L}+\\s+)?capturas?`), false],
];

interface ScopeCue {
  scope: CountScope;
  /** Es un verbo de captura (el único que puede regir «fichas»). */
  verb: boolean;
  start: number;
  end: number;
  priority: number;
}

function scopeCuesIn(sentence: string): ScopeCue[] {
  return SCOPE_CUES.flatMap(([scope, re, verb], priority) =>
    [...sentence.matchAll(re)].map((m) => ({ scope, verb, priority, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })),
  );
}

/** La señal más cercana a la cifra (a igual distancia, la de más prioridad); `null` si no hay ninguna. */
function nearestScope(cues: readonly ScopeCue[], start: number, end: number): CountScope | null {
  const distance = (c: ScopeCue) => (c.end <= start ? start - c.end : c.start >= end ? c.start - end : 0);
  const best = [...cues].sort((a, b) => distance(a) - distance(b) || a.priority - b.priority)[0];
  return best?.scope ?? null;
}

/** El recuento real de un ámbito, si la intervención lo tiene (si no, la cifra no es verificable). */
function factFor(scope: CountScope, request: ChatWriteRequest): StreakFacts | null {
  const u = request.utterance;
  const c = u.captures;
  // Historial incompleto: ningún recuento es verificable (tampoco el `streak` del mensaje principal).
  if (c?.history === "incomplete") return null;
  if (c) {
    const table: Record<CountScope, StreakFacts | null> = {
      selfMadeSinceBreak: c.self.madeSinceBreak,
      rivalMadeSinceBreak: c.rival.madeSinceBreak,
      selfReceivedSinceBreak: c.self.receivedSinceBreak,
      rivalReceivedSinceBreak: c.rival.receivedSinceBreak,
      selfOnRival: c.selfOnRival,
      rivalOnSelf: c.rivalOnSelf,
      selfMade: c.self.made,
      rivalMade: c.rival.made,
      selfReceived: c.self.received,
      rivalReceived: c.rival.received,
      selfStreak: c.self.streak,
      rivalStreak: c.rival.streak,
      selfBad: c.self.badStreak,
      rivalBad: c.rival.badStreak,
    };
    return table[scope];
  }
  // Sin hechos de captura, solo la racha propia del mensaje principal de una racha.
  if (!u.streak || u.replyTo !== null) return null;
  if (u.kind === "streak_boast" && (scope === "selfMade" || scope === "selfStreak")) return u.streak;
  if (u.kind === "streak_lament" && (scope === "selfReceived" || scope === "selfBad")) return u.streak;
  return null;
}

/**
 * El recuento al que se refiere una cifra sin sujeto («¡Tres capturas ya!»): la racha que provocó la
 * intervención. En `capture_streak`, la racha activa de quien captura; en `bad_streak`, la mala racha
 * activa de quien recibe. En una captura simple no hay ninguna: la cifra no es verificable.
 */
function topicFact(request: ChatWriteRequest): StreakFacts | null {
  const u = request.utterance;
  const c = u.captures;
  if (c?.history === "incomplete") return null;
  if (u.streak && u.replyTo === null) return u.streak;
  if (!c) return null;
  const capturer = c.selfRole === "by" ? c.self : c.rival;
  const victim = c.selfRole === "by" ? c.rival : c.self;
  if (u.trigger === "capture_streak" && capturer.streak?.status === "active") return capturer.streak;
  if (u.trigger === "bad_streak" && victim.badStreak?.status === "active") return victim.badStreak;
  return null;
}

/**
 * Las cifras de capturas deben coincidir con el recuento real AL QUE SE REFIEREN, con su sujeto y su
 * dirección (`utterance.captures`, calculado por el director desde quien habla, también en las
 * réplicas):
 * - «me has capturado tres veces» es la pareja rival → quien habla; «te he pillado dos veces», quien
 *   habla → rival; «llevo», «mis capturas», las hechas por quien habla; «llevas», «lleva», las del
 *   rival; «me han capturado», las recibidas; «tu racha», «mi mala racha», esas rachas (también si
 *   acaban de interrumpirse). Con varias señales en la frase, cuenta la más cercana a la cifra.
 * - Sin sujeto («¡Tres capturas ya!»), la racha que provocó la intervención (`topicFact`).
 * - Si el recuento no existe en la intervención (victoria, captura simple sin sujeto, datos antiguos),
 *   la cifra no es verificable y se rechaza. El recuento global de una racha NUNCA respalda una cifra
 *   de pareja.
 * - Cifras: «N capturas», «N veces», «una vez», ordinales («la primera vez», «la tercera captura»),
 *   «N fichas» regidas por un verbo de captura y cifras sin sustantivo («¡Ya van tres!», «llevo dos»).
 *   «una vez más», «de una vez», «por una vez», «una vez que», «otra vez» y «alguna vez» no son cifras.
 * - «desde entonces llevas una» es el tramo desde la última interrupción (`madeSinceBreak`…).
 * - «una captura» / «una ficha» (artículo indefinido) se admite solo como la captura de esta versión:
 *   sin sujeto o con el sujeto que le corresponde. En la victoria, no.
 * - «seguidas/os» y «consecutivas/os», con cifra o sin ella, exigen que ese mismo recuento sea de
 *   capturas consecutivas.
 */
function checkCountClaims(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  const unsupported = (term: string): QualityIssue => ({ reason: "afirmación no respaldada", term });
  const u = request.utterance;
  // «una captura» / «una ficha» con artículo indefinido puede ser la captura de esta versión: sin sujeto,
  // o con un sujeto compatible con ella (quien captura la hace, quien la recibe la recibe). «una vez» y
  // los ordinales («la primera captura», «la primera vez») son recuentos y se comprueban como los demás.
  const current: ReadonlySet<CountScope> =
    u.captures?.selfRole === "by"
      ? new Set(["selfOnRival", "selfMade", "rivalReceived"])
      : u.captures?.selfRole === "victim"
        ? new Set(["rivalOnSelf", "rivalMade", "selfReceived"])
        : new Set();
  const isThisCapture = (claim: CountClaim, scope: CountScope | null) =>
    claim.n === 1 && claim.indefinite === true && CAPTURE_TRIGGERS.has(u.trigger) && (scope === null || current.has(scope));
  const resolve = (scope: CountScope | null) => ({ scope, fact: scope ? factFor(scope, request) : topicFact(request) });
  const label = (scope: CountScope | null) => (scope ? `, ${SCOPE_LABELS[scope]}` : "");
  // Historial incompleto: solo la captura de esta versión es un hecho; cualquier otra cifra y «seguidas», no.
  const incomplete = u.captures?.history === "incomplete";
  const notConsecutive = (word: string, scope: CountScope | null, fact: StreakFacts | null) =>
    incomplete
      ? unsupported(`${word} (historial incompleto)`)
      : unsupported(scope ? `${word} (${fact && fact.count > 0 ? "no seguidas" : "sin datos"}${label(scope)})` : `${word} (${fact ? "real en poco tiempo" : "sin racha"})`);

  for (const sentence of t.split(/[.!?;:…]+/)) {
    const cues = scopeCuesIn(sentence);
    const claims = countClaimsIn(sentence);
    for (const claim of claims) {
      const fichas = claim.noun.startsWith("ficha");
      // «fichas» solo es una cifra de capturas si la rige un verbo de captura.
      const candidates = fichas ? cues.filter((c) => c.verb) : cues;
      if (fichas && candidates.length === 0) continue;
      const near = nearestScope(candidates, claim.start, claim.end);
      if (isThisCapture(claim, near)) continue;
      const { scope, fact } = resolve(near);
      if (incomplete) return unsupported(`cifra ${claim.n} (historial incompleto)`);
      if (!fact) return unsupported(scope ? `cifra ${claim.n} (sin datos${label(scope)})` : `cifra ${claim.n} (real sin racha)`);
      if (claim.n !== fact.count) return unsupported(`cifra ${claim.n} (real ${fact.count}${label(scope)})`);
      if (STREAK_WORD.test(claim.noun) && !fact.consecutive) return notConsecutive(claim.noun, scope, fact);
    }
    // «seguidas» / «consecutivas» fuera de una cifra («dos veces seguidas», «¡Seguidas!»).
    for (const m of sentence.matchAll(STREAK_WORD_ALL)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claims.some((c) => c.start <= start && end <= c.end)) continue;
      if (isDiceSequence(sentence, start, t)) continue; // «dos seises seguidos»: del dado, no de capturas
      const { scope, fact } = resolve(nearestScope(cues, start, end));
      if (!fact?.consecutive) return notConsecutive(m[1], scope, fact);
    }
  }
  return null;
}

// ── Longitud en frases ─────────────────────────────────────────────────────────────────────────────

/** Abreviaturas que terminan en punto y no cierran una frase. */
const ABBREVIATIONS = /(?:^|[\s(«"“])(?:sr|sra|srta|sres|dña|dn|dr|dra|ud|uds|vd|vds|etc|pág|núm|ej|p)\.$/iu;
const MAX_SENTENCES = 2;

/**
 * Número de frases: cuenta los cierres (`.`, `!`, `?`, `…`, solos o repetidos) seguidos de otra frase que
 * empieza en mayúscula o con `¡`/`¿`. Los puntos suspensivos o la puntuación seguidos de minúscula
 * («Ay… ya veremos») no cortan la frase, ni el punto de una abreviatura («Sra. Pilar»).
 */
export function countSentences(text: string): number {
  let count = 1;
  for (const m of text.trim().matchAll(/[.!?…]+(?=\s+[«"“(]?[¡¿]?[\p{Lu}])/gu)) {
    const before = text.slice(0, (m.index ?? 0) + m[0].length);
    if (m[0] === "." && ABBREVIATIONS.test(before)) continue;
    count++;
  }
  return count;
}

function checkSentences(text: string): QualityIssue | null {
  const n = countSentences(text);
  return n > MAX_SENTENCES ? { reason: "demasiadas frases", term: `frases=${n}` } : null;
}

// ── Nombres mal usados: «Don» truncado y Pilar llamando «abuela» a otro ──────────────────────────────

/** Determinantes ante «don» como nombre común («un don», «qué don», «tu don»). */
const DON_COMMON = /(?:^|[^\p{L}])(?:un|el|ese|este|mi|tu|su|gran|buen|menudo|qué|que|vaya)\s+$/iu;

/**
 * «Don» o «Dón» con mayúscula usado como nombre, sin «Ernesto» detrás («¡Dón, te vas a quedar…!»). No
 * cuenta «Don Ernesto» ni el nombre común («tienes un don»).
 */
function truncatedDon(text: string): QualityIssue | null {
  for (const m of text.matchAll(/(?<![\p{L}])D[oó]n(?![\p{L}])(?!\s+Ernesto)/gu)) {
    if (DON_COMMON.test(text.slice(0, m.index))) continue;
    return { reason: "mezcla nombres de personajes", term: "don" };
  }
  return null;
}

/**
 * Pilar llamando «abuela» a otro personaje: «abuela» como vocativo (sola entre signos, al principio o al
 * final de una frase: «…, abuela.», «Abuela, …», «¡Abuela!»). Hablar de sí misma como «la abuela» o
 * «esta abuela» sigue permitido.
 */
function pilarCallsOthersAbuela(text: string, speaker: string): QualityIssue | null {
  if (speaker !== "ai-green") return null;
  const t = normalize(text);
  const vocative = /(?:^|[,;:¡¿.!?…]\s*)abuela(?![\p{L}])(?=\s*(?:[,;:.!?…]|$))/u;
  return vocative.test(t) ? { reason: "mezcla nombres de personajes", term: "abuela (vocativo)" } : null;
}

// ── Rachas: menciones, continuación y fin ──────────────────────────────────────────────────────────

/**
 * Una mención de racha: con su dueño si lo dice («mi», «tu», «su»; o el pronombre de «se te acabó la
 * racha»), su tipo («mala racha», «racha negra»… es la mala racha; si no, la racha de capturas) y lo
 * que afirma de ella: que termina, que sigue o nada (solo la nombra).
 */
const MENTION = new RegExp(`(?<![\\p{L}])(?:(mi|tu|su|la|esta|esa|una|vaya|que|menuda)\\s+)?(mala\\s+)?rachas?(\\s+${BAD_SUFFIX})?(?![\\p{L}])`, "gu");
/** Lo que sigue a «racha» cuando habla de la suerte o del dado: «racha de suerte», «racha con el dado». */
const LUCK_AFTER = /^\s+(?:de\s+(?:buena\s+|mala\s+)?suerte|(?:con|de)\s+(?:el\s+|los\s+)?dados?|del\s+dado|de\s+(?:seises|cincos|tiradas))(?![\p{L}])/u;
/**
 * Vocabulario de capturas en el texto (normalizado: sin tildes): si aparece, «racha» o «seguidos» pueden
 * hablar de capturas y se comprueban. Incluye «cazar» con c delante de e («cacé», «caces», «cacemos»,
 * «cacen»), los gerundios («comiéndote», «cazándote») y «a casita».
 */
const CAPTURE_VOCAB =
  /(?<![\p{L}])(?:captur\p{L}*|pill\p{L}*|caz(?:a|as|o|ar|aste|ado|ada|ados|adas|amos|an|ais)|cac(?:e|es|emos|eis|en)|cazand\p{L}*|comid\p{L}*|comer\p{L}*|comiend\p{L}*|(?:te|le|la|lo|me|os|les)\s+com\p{L}*|fichas?|a\s+casa|a\s+casita)(?![\p{L}])/u;

/** Quien habla está en el lado que pierde: le acaban de capturar o responde a la victoria de otro. */
const LOSING_KINDS: ReadonlySet<string> = new Set(["capture_lament", "streak_lament", "victory_reply"]);
const isLosingSide = (request: ChatWriteRequest) =>
  LOSING_KINDS.has(request.utterance.kind) || request.utterance.captures?.selfRole === "victim";

/**
 * Mención coloquial de la suerte o del dado, que no afirma nada sobre capturas: «¡Qué racha de suerte con
 * el dado!», «Vaya mala racha llevo hoy», «menuda racha de seises». Solo si dice de qué habla (suerte,
 * dado o «mala racha»), sin dueño («mi», «tu», «su»: entonces es la racha de alguien y se comprueba) y sin
 * vocabulario de capturas en TODO el texto (no solo en su frase: «Qué racha de suerte: te he comido otra
 * vez» habla de capturas). «¡Vaya racha!» a secas no lo es.
 * La MALA suerte («mala racha», «racha de mala suerte») solo encaja en el lado que pierde: dicha por quien
 * acaba de capturar o de ganar es contradictoria («¡Mala racha, Don Ernesto! Hoy no es mi día», dicho por
 * Chispa al capturar, partida 707c3c6d…) y se sigue comprobando como una racha.
 */
function isLuckMention(sentence: string, m: RegExpMatchArray, request: ChatWriteRequest, text: string): boolean {
  if (m[1] === "mi" || m[1] === "tu" || m[1] === "su") return false;
  const after = sentence.slice((m.index ?? 0) + m[0].length);
  const badLuck = Boolean(m[2]) || /mala|negra|adversa/.test(m[3] ?? "") || /^\s+de\s+mala\s+suerte/.test(after);
  const aboutLuck = LUCK_AFTER.test(after) || badLuck || /suerte/.test(m[3] ?? "");
  if (!aboutLuck || CAPTURE_VOCAB.test(text)) return false;
  return !badLuck || isLosingSide(request);
}
const END_VERBS_PAST = "acabo|termino|rompio|corto|ha\\s+(?:acabado|terminado|roto|cortado)|han\\s+(?:roto|cortado)|he\\s+(?:roto|cortado)|rompi|acabe\\s+con|acabaste\\s+con|acabo\\s+con";
/** Delante de la mención: «se acabó tu racha», «se te ha cortado la racha», «fin de su racha», «adiós a tu racha». */
const END_VERBS_PRESENT = "acaba|termina|rompe|corta";
const END_BEFORE = new RegExp(
  `(?<![\\p{L}])(?:fin\\s+de|adios\\s+a|se\\s+(?:(me|te|le)\\s+)?(?:${END_VERBS_PRESENT})|(?:se\\s+)?(?:(me|te|le)\\s+)?(?:${END_VERBS_PAST}))\\s+$`,
  "u",
);
/** Delante de la mención, en negativo o de continuidad: «no se acabó tu racha», «sigue tu racha». */
const CONTINUE_BEFORE = new RegExp(
  `(?<![\\p{L}])(?:sigue|continua|no\\s+(?:se\\s+)?(?:(?:me|te|le)\\s+)?(?:${END_VERBS_PRESENT}|${END_VERBS_PAST}))\\s+$`,
  "u",
);
/** Palabras entre la mención y el verbo («tu racha de tres capturas se acabó»), sin negación. */
const GAP = "(?:\\s+(?!(?:no|nunca|jamas|ni)(?![\\p{L}]))[\\p{L}\\p{N}()]+){0,4}?";
/** Detrás de la mención: «tu racha se acaba», «mi mala racha ha llegado a su fin». */
const END_AFTER = new RegExp(
  `^${GAP}\\s+(?:ya\\s+)?(?:se\\s+)?(?:(?:me|te|le)\\s+)?(?:acaba|acabo|termina|termino|rompe|rompio|corta|corto|ha\\s+(?:acabado|terminado|llegado\\s+a\\s+su\\s+fin)|se\\s+ha\\s+(?:acabado|terminado|roto|cortado)|(?:llega|toca)\\s+a\\s+su\\s+fin)(?![\\p{L}])`,
  "u",
);
/** Detrás de la mención, de continuidad: «tu racha sigue», «mi racha no se acaba». */
const CONTINUE_AFTER = new RegExp(
  `^${GAP}\\s+(?:sigue|continua|no\\s+(?:se\\s+)?(?:(?:me|te|le)\\s+)?(?:acaba|termina|para|corta|rompe|ha\\s+(?:acabado|terminado|roto|cortado)))(?![\\p{L}])`,
  "u",
);
/**
 * Deseos e hipótesis no afirman nada: «a ver si se acaba tu racha», «si se acaba tu racha, lo
 * celebraré», «tu racha se acaba si te pillo». Solo cuentan DENTRO DE LA MISMA CLÁUSULA que la mención
 * (`clauseAround`): «Si quieres, se acabó tu racha» o «Quizá mañana gane, pero se acabó tu racha»
 * afirman. Se mira sobre el texto en minúsculas CON tildes para distinguir «si» (condicional) de «sí»
 * (afirmación); «Si,» con coma queda en su propia cláusula. Los subjuntivos («que se acabe», «ojalá se
 * haya acabado») y los futuros («se acabará») no coinciden con los verbos de fin.
 */
const HYPOTHETICAL = /(?<![\p{L}])(?:ojalá|ojala|a ver si|si|cuando|hasta que|como si|quizá|quizás|quiza|quizas|tal vez|puede que)(?![\p{L}])/u;
/** Límites de cláusula dentro de una frase: comas, paréntesis, rayas y conjunciones que separan cláusulas. */
const CLAUSE_BREAK = /[,()—–]|\s(?:pero|aunque|y|o|mientras|porque|pues)\s/gu;

/** La cláusula de `sentence` que contiene la posición `[start, end)`. */
function clauseAround(sentence: string, start: number, end: number): { from: number; to: number } {
  let from = 0;
  let to = sentence.length;
  for (const m of sentence.matchAll(CLAUSE_BREAK)) {
    const at = m.index ?? 0;
    if (at + m[0].length <= start) from = at + m[0].length;
    else if (at >= end) {
      to = at;
      break;
    }
  }
  return { from, to };
}

/** La mención está dentro de una pregunta: tras un «¿» sin cerrar, o en una frase que acaba en «?» sin «¿». */
function inQuestion(sentence: string, start: number): boolean {
  const open = sentence.lastIndexOf("¿", start);
  if (open >= 0 && !sentence.slice(open, start).includes("?")) return true;
  return !sentence.includes("¿") && sentence.trimEnd().endsWith("?");
}

type StreakOwner = "self" | "rival" | null;
type StreakClaim = "end" | "continue" | "mention";

/** Estado real de la racha (o mala racha) de un dueño; con dueño desconocido, de cualquiera de los dos. */
function streakStates(c: CompleteCaptureFacts, owner: StreakOwner, bad: boolean): (StreakState | null)[] {
  const sides = owner === "self" ? [c.self] : owner === "rival" ? [c.rival] : [c.self, c.rival];
  // Una mención sin tipo ni dueño («¡Vaya racha!») puede ser de cualquiera de las dos rachas.
  return sides.flatMap((side) => (bad ? [side.badStreak] : [side.streak]));
}

/**
 * Lo que se dice de una racha debe coincidir con su estado real (`utterance.captures`, calculado por el
 * director a partir de las capturas reales):
 * - Afirmar que termina («se acabó tu racha», «tu mala racha se ha cortado», «fin de su racha») solo si
 *   esa racha se acaba de interrumpir (`ended`); si sigue (`active`) o no existe, se rechaza.
 * - Afirmar que sigue («tu racha sigue», «no se acaba») solo si está activa.
 * - Nombrarla («mi racha», «tu mala racha», «¡Vaya racha!») solo si existe (activa o recién
 *   interrumpida). Sin hechos de captura (datos antiguos), solo cuenta el disparador (`checkGameTalk`),
 *   y el fin de una racha no es verificable: se rechaza.
 * - Las preguntas, los deseos y las hipótesis no se comprueban (no afirman nada).
 * - Con el historial incompleto no se sabe si nadie está de racha: cualquier mención se rechaza, también
 *   en preguntas, deseos o hipótesis (presuponen una racha que no se puede comprobar).
 * Dueño: «mi»/«me» es quien habla; «tu», «su», «te», «le», el rival. Tipo: «mala racha», «racha negra»…
 * es la mala racha; si no, la racha de capturas (en las menciones sin dueño ni «mala», cualquiera).
 */
function checkStreakEnd(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  const lower = text.toLowerCase();
  const aligned = lower.length === t.length;
  const c = request.utterance.captures ?? null;
  const unsupported = (term: string): QualityIssue => ({ reason: "afirmación no respaldada", term });

  for (const piece of t.matchAll(/[^.!?;:…]+[.!?;:…]*/gu)) {
    const sentence = piece[0];
    const offset = piece.index ?? 0;
    for (const m of sentence.matchAll(MENTION)) {
      const start = m.index ?? 0;
      const before = sentence.slice(0, start);
      const after = sentence.slice(start + m[0].length);
      const continueBefore = CONTINUE_BEFORE.test(before);
      const endBefore = !continueBefore ? END_BEFORE.exec(before) : null;
      const endAfter = !continueBefore ? END_AFTER.exec(after) : null;
      const continueAfter = CONTINUE_AFTER.exec(after);
      const claim: StreakClaim =
        continueBefore || continueAfter ? "continue" : endBefore || endAfter ? "end" : "mention";
      const pronoun = endBefore?.[1] ?? endBefore?.[2] ?? null;
      const ownerWord = m[1] ?? null;
      const owner: StreakOwner = ownerWord === "mi" || pronoun === "me" ? "self" : ownerWord === "tu" || ownerWord === "su" || pronoun === "te" || pronoun === "le" ? "rival" : null;
      const bad = Boolean(m[2] || m[3]);
      // La cláusula que contiene la mención y su verbo (delante o detrás); un deseo o una hipótesis en
      // OTRA cláusula no cuenta.
      const verbStart = endBefore ? endBefore.index : continueBefore ? start : start;
      const verbEnd = start + m[0].length + (endAfter?.[0].length ?? continueAfter?.[0].length ?? 0);
      const clause = clauseAround(sentence, Math.min(verbStart, start), verbEnd);
      const context = aligned ? lower.slice(offset + clause.from, offset + clause.to) : sentence.slice(clause.from, clause.to);
      const hedged = inQuestion(sentence, start) || HYPOTHETICAL.test(context);

      // Una mención coloquial de la suerte o del dado, sin dueño ni verbo de seguir o acabar, no habla de
      // ninguna racha de capturas: no se compara con los hechos.
      if (claim === "mention" && owner === null && isLuckMention(sentence, m, request, t)) continue;
      if (c?.history === "incomplete") return unsupported("racha (historial incompleto)");
      if (claim !== "mention" && hedged) continue;
      if (!c) {
        if (claim === "end") return unsupported("fin de racha");
        continue; // la mención y la continuidad sin hechos las decide el disparador (`checkGameTalk`)
      }
      const states = bad || owner !== null || claim !== "mention" ? streakStates(c, owner, bad) : [...streakStates(c, owner, false), ...streakStates(c, owner, true)];
      if (claim === "end" && !states.some((s) => s?.status === "ended")) return unsupported("fin de racha");
      if (claim === "continue" && !states.some((s) => s?.status === "active")) return unsupported("racha que sigue");
      if (claim === "mention" && !states.some((s) => s !== null)) return unsupported("racha");
    }
  }
  return null;
}

/** La intervención tiene alguna racha que respalde hablar de rachas: su disparador o sus hechos. */
function hasStreakContext(request: ChatWriteRequest): boolean {
  const c = request.utterance.captures;
  if (STREAK_TRIGGERS.has(request.utterance.trigger)) return true;
  return Boolean(c?.history === "complete" && [c.self.streak, c.self.badStreak, c.rival.streak, c.rival.badStreak].some((s) => s !== null));
}

// ── Género del destinatario ────────────────────────────────────────────────────────────────────────

/**
 * Apelativos con género (sin tildes, tras `normalize`): masculino y femenino. Solo los inequívocos como
 * vocativo; no los que también son adjetivos de uso frecuente («bonito», «pequeño») ni los neutros
 * («cariño», «cielo», «tesoro»). El plural («hijos») se dirige a todos y no cuenta.
 */
const GENDERED_VOCATIVES: Readonly<Record<string, "f" | "m">> = {
  hijo: "m", hija: "f", hijito: "m", hijita: "f", niño: "m", niña: "f", niñito: "m", niñita: "f",
  guapo: "m", guapa: "f", majo: "m", maja: "f", chiquillo: "m", chiquilla: "f", querido: "m", querida: "f",
  chaval: "m", chavala: "f", campeon: "m", campeona: "f", rey: "m", reina: "f",
};
/**
 * Vocativo: al principio, tras un signo o tras una interjección («ay», «oye», «mira», «venga», «anda»,
 * «uy»), con «mi» delante o «mío/mía» detrás, y seguido de un signo o del final.
 */
const VOCATIVE = new RegExp(
  `(?:^|[¡!¿?.,;:…(—-]\\s*|(?<![${LETTER}])(?:ay|oye|mira|venga|anda|uy|hala)\\s+)(?:mi\\s+)?(${Object.keys(GENDERED_VOCATIVES).join("|")})(?:\\s+mi[oa])?\\s*(?=$|[!?.,;:…)—])`,
  "gu",
);

/**
 * Un apelativo con género en vocativo se dirige a la otra parte de la intervención (el rival; en una
 * réplica, quien dijo el mensaje): su género debe ser el de ese personaje (Pilar llamaba «hijita» a Chispa
 * y «hijito» a Brava). Sin rival (victoria propia) no hay destinatario con el que comparar y no se
 * comprueba: «Ay, hijo, qué partida más larga» es ahí una interjección.
 */
function checkAddresseeGender(text: string, request: ChatWriteRequest): QualityIssue | null {
  const rival = request.utterance.rival ? getCharacter(request.utterance.rival) : undefined;
  if (!rival) return null;
  for (const match of normalize(text).matchAll(VOCATIVE)) {
    const word = match[1];
    if (GENDERED_VOCATIVES[word] !== rival.gender) {
      return { reason: "no concuerda el género del destinatario", term: `${word} (${rival.name}: ${rival.gender === "f" ? "femenino" : "masculino"})` };
    }
  }
  return null;
}

// ── Final de la partida ────────────────────────────────────────────────────────────────────────────

/**
 * Afirmar que la partida ha terminado (sin tildes, tras `normalize`): «la partida ha terminado», «se
 * acabó la partida», «partida terminada», «fin de la partida», «juego terminado»… Solo con «partida» o
 * «juego»: una jugada, un movimiento, un turno o una ficha terminados no cuentan. Ni la negación («la
 * partida no ha terminado») ni el final para uno mismo («se acabó la partida para mí»).
 */
const NOT = `(?<!(?<![${LETTER}])no\\s+(?:se\\s+|ha\\s+|ya\\s+|aun\\s+|todavia\\s+)*)`;
const ENDED = "(?:terminado|acabado|terminada|acabada|finalizado|finalizada|concluido|concluida)";
const END_VERB = "(?:se\\s+(?:ha\\s+)?(?:acabo|termino|acaba|termina|acabado|terminado)|ha\\s+(?:terminado|acabado|finalizado|concluido)|termino|acabo|finalizo|concluyo)";
const GAME = "(?:la\\s+|esta\\s+)?(?:partida|juego)";
const GAME_OVER = new RegExp(
  `(?<![${LETTER}])(?:${GAME}\\s+(?:ya\\s+)?${NOT}${END_VERB}|${NOT}${END_VERB}\\s+(?:ya\\s+)?${GAME}|${GAME}\\s+${ENDED}|fin\\s+(?:de\\s+la\\s+partida|del\\s+juego))(?![${LETTER}])(?!\\s+para\\s)`,
  "u",
);

/**
 * Con el estado real de la partida en juego (`gameStatus: "playing"`), no se puede decir que ha terminado:
 * la victoria es del primero en llegar, pero los demás siguen jugando por los otros puestos (la réplica de
 * Brava «No esperaba la partida terminada así» en la partida 010c5ace…). Con la partida terminada o sin
 * estado (no se sabe), no se comprueba.
 */
function checkGameOverClaim(text: string, request: ChatWriteRequest): QualityIssue | null {
  if (request.gameStatus !== "playing") return null;
  return GAME_OVER.test(normalize(text)) ? { reason: "afirmación no respaldada", term: "fin de la partida" } : null;
}

// ── Naturalidad: expresiones artificiales vistas en Preview ──────────────────────────────────────────

/**
 * Pedirle algo al dado como si alguien pudiera dárselo («¡Dadme ese seis, por favor!», «dame un seis»),
 * sin tildes, tras `normalize`.
 */
const DICE_REQUEST = [
  /(?<![\p{L}])(?:dadme|dame|deme|denme|dadnos|danos)\s+(?:un|ese|el|otro|algun)\s+(?:seis|cinco|uno|dos|tres|cuatro)(?![\p{L}])/u,
  /(?:seis|cinco|dado)[^.!?…]*por\s+favor|por\s+favor[^.!?…]*(?:seis|cinco|dado)/u,
];
/**
 * Expresiones que no son naturales para lo que pasa en el parchís: «golpe» (salvo «de golpe» y «golpe de
 * suerte», que sí lo son) y «da sus frutos».
 */
/**
 * «Racha dos», «Racha 2», «racha tres», «Racha: 3», «racha nº 4»…: «racha» seguida directamente de un número, en
 * letras o en cifras, con o sin separador («:», «#», «-», «x», «nº»; la coma no). Prohibido con cualquier número, aunque la racha sea real. No cuentan
 * «una racha de dos capturas» (con «de»), «mi racha sigue» ni «racha de suerte». «un»/«una»/«un par de» no se
 * usan aquí («una racha un poco rara» no es esta estructura); «uno», sí.
 */
const STREAK_NUMBER_WORDS = Object.keys(NUMBER_WORDS)
  .filter((w) => !/^un(?:a|\s+par\s+de)?$/.test(w))
  .sort((a, b) => b.length - a.length)
  .join("|");
const STREAK_NUMBER = new RegExp(
  `(?<![\\p{L}])rachas?\\s*(?:[:#\\-–—x×]\\s*|(?:numero|num|n[ºo°]\\.?)\\s*)?(?:\\d+|${STREAK_NUMBER_WORDS})(?![\\p{L}\\p{N}])`,
  "u",
);

const UNNATURAL: readonly { term: string; re: RegExp }[] = [
  { term: "golpe", re: /(?<![\p{L}])(?<!de\s)golpes?(?![\p{L}])(?!\s+de\s+suerte)/u },
  { term: "da sus frutos", re: /(?<![\p{L}])(?:da|dan|dar|dio|dieron|ha\s+dado|han\s+dado)\s+sus\s+frutos(?![\p{L}])/u },
  // «Su ficha quedó en la calle»: metáfora que nadie usa jugando al parchís (la ficha vuelve a casa).
  { term: "en la calle", re: /(?<![\p{L}])en\s+la\s+calle(?![\p{L}])/u },
  // Frases hechas que se repetían en las pruebas reales y sus variantes equivalentes: «La partida sigue
  // muy abierta. Habrá que estar atentos.» y «Tres seguidas y aún tengo hambre.». «Tengo hambre» o
  // «estad atentos» sueltos no cuentan.
  { term: "partida abierta", re: /(?<![\p{L}])partida\s+(?:sigue|esta|continua)\s+(?:muy\s+|bastante\s+|todavia\s+|aun\s+)?abierta(?![\p{L}])/u },
  { term: "estar atentos", re: /(?<![\p{L}])(?:habra|hay|tendremos|tocara)\s+que\s+estar\s+atent[oa]s?(?![\p{L}])/u },
  { term: "aún tengo hambre", re: /(?<![\p{L}])(?:(?:aun|todavia)\s+(?:tengo|me\s+queda|me\s+quedo\s+con)\s+hambre|sigo\s+con\s+hambre)(?![\p{L}])/u },
  // Expresiones retiradas: «¡Me la he quedado!» (y «me la quedo», «quedármela», «me quedo con tu ficha»)
  // para celebrar una captura, «contratiempo» («Un pequeño contratiempo») y «en cabeza» («voy en cabeza»,
  // «va en cabeza»): para decir que va ganando, «voy ganando», y solo con respaldo (ver `positionClaims.ts`).
  {
    term: "me la he quedado",
    re: /(?<![\p{L}])(?:(?:me|nos)\s+(?:la|las)\s+(?:(?:he|hemos|habia)\s+)?qued(?:o|e|ado|amos|ao)|quedarmela?s?|quedarnosla?s?|me\s+quedo\s+con\s+(?:tu|su|vuestra|esa|la)\s+ficha)(?![\p{L}])/u,
  },
  // «Me lo he quedado»: quedarse con algo usando «lo/los», en cualquier persona y tiempo («me lo quedo», «me los
  // quedé», «te lo has quedado», «se lo ha quedado», «nos lo vamos a quedar», «quedármelo», «quedándoselo»). No
  // cuentan los usos de «quedarse» sin ese pronombre («me quedo sin turno», «me he quedado con una ficha en casa»,
  // «lo que queda de partida»).
  {
    term: "me lo he quedado",
    re: /(?<![\p{L}])(?:(?:me|te|se|nos|os)\s+los?\s+(?:(?:he|has|ha|hemos|habeis|han|habia|habias|habiamos|habian|voy\s+a|vas\s+a|va\s+a|vamos\s+a|vais\s+a|van\s+a)\s+)?qued\p{L}*|qued(?:ar|ando)(?:me|te|se|nos|os)los?)(?![\p{L}])/u,
  },
  { term: "contratiempo", re: /(?<![\p{L}])contratiempos?(?![\p{L}])/u },
  { term: "en cabeza", re: /(?<![\p{L}])en\s+cabeza(?![\p{L}])/u },
  // Giros artificiales retirados del catálogo: «Sigo aquí, y con ganas.» y «¡Dentro! Y sin pedir permiso.».
  { term: "sigo aquí y con ganas", re: /(?<![\p{L}])sigo\s+aqui\s*,?\s+y\s+con\s+ganas(?![\p{L}])/u },
  { term: "sin pedir permiso", re: /(?<![\p{L}])sin\s+pedir(?:le|les)?\s+permiso(?![\p{L}])/u },
  // Capturar es «comer»: «Te la he quitado», «Me ha quitado una ficha», «me han quitado una ficha» no se dicen
  // así. (Las formas naturales: «Te he comido», «He comido tu ficha», «Me has comido una ficha».)
  {
    term: "quitar una ficha",
    re: /(?<![\p{L}])(?:(?:me|te|le|nos|os|les)\s+(?:(?:la|las|lo)\s+)?(?:(?:he|has|ha|hemos|habeis|han)\s+)?quit(?:ado|aste|o|e|as|a|an|amos|asteis|aron)|quitad[oa]\s+(?:una|la|mi|tu|su)\s+ficha|quitar(?:me|te|le)?\s+(?:una|la|mi|tu|su)\s+ficha)(?![\p{L}])/u,
  },
  // Narración de comentarista: «una captura de libro», «una jugada de manual».
  { term: "de libro", re: /(?<![\p{L}])de\s+(?:libro|manual)(?![\p{L}])/u },
  // Frase retirada: «¡Ay, pobre Abuela! Se le escapa la captura.» (y sus dos giros por separado).
  { term: "pobre abuela", re: /(?<![\p{L}])pobre\s+abuela(?![\p{L}])/u },
  // La misma compasión con cualquier otro personaje («…, pobre Don Ernesto!»).
  { term: "pobre + nombre", re: /(?<![\p{L}])pobre\s+(?:don\s+ernesto|ernesto|pilar|brava|chispa)(?![\p{L}])/u },
  { term: "se le escapa la captura", re: /(?<![\p{L}])se\s+(?:le|te|me|les|nos|os)\s+(?:escapa|escapo|escapan|ha\s+escapado|han\s+escapado)\s+(?:la|una|esa|otra)\s+captura(?![\p{L}])/u },
  // Al grupo, Abuela Pilar dice «hijos», no «cariños». «Cariño», a un solo rival, sí.
  { term: "cariños", re: /(?<![\p{L}])cariños(?![\p{L}])/u },
  // Frases retiradas por genéricas: «Sigo en la pelea» (y «sigo dando pelea», «seguimos en la pelea», «aún doy
  // pelea») y «Mantengo la ventaja» (y «mantengo mi ventaja», «conservo la ventaja»). «Hasta el dado quiere
  // pelea» o «no confunda ventaja con victoria» no cuentan.
  {
    term: "sigo en la pelea",
    re: /(?<![\p{L}])(?:(?:sigo|seguimos|sigue|sigues|continuo|continuamos)\s+(?:en\s+la\s+pelea|dando\s+(?:la\s+)?pelea)|(?:aun|todavia)\s+doy\s+(?:la\s+)?pelea)(?![\p{L}])/u,
  },
  // Frases retiradas del chat (catálogo local y respuestas del LLM), con sus variantes equivalentes. Solo las
  // frases: palabras sueltas como «racha», «dado» o «abuela» siguen valiendo en otras expresiones.
  {
    term: "te comes a la abuela",
    re: /(?<![\p{L}])(?:(?:te|os|se)\s+(?:comes|comeis|come|comen|comiste|comisteis|comio|(?:has|habeis|ha|han)\s+comido)|comer(?:te|os|se))\s+a\s+la\s+abuela(?![\p{L}])/u,
  },
  { term: "ya tengo cuatro", re: /(?<![\p{L}])ya\s+(?:tengo|tenemos)\s+(?:las\s+)?cuatro(?![\p{L}])/u },
  {
    term: "he sacado un seis, me comiste",
    re: /(?<![\p{L}])he\s+sacado\s+un\s+seis[^.!?…]*?(?<![\p{L}])me\s+(?:comiste|has\s+comido|comes)(?![\p{L}])/u,
  },
  { term: "el dado me debe una", re: /(?<![\p{L}])dado\s+me\s+(?:la\s+|las\s+)?debe(?![\p{L}])|(?<![\p{L}])me\s+debe\s+una\s+el\s+dado(?![\p{L}])/u },
  {
    term: "se me fue la ficha",
    re: /(?<![\p{L}])se\s+me\s+(?:fue|va|ha\s+ido|escapo|escapa|ha\s+escapado)\s+(?:la|una|mi|esa)\s+ficha(?![\p{L}])/u,
  },
  { term: "racha intacta", re: /(?<![\p{L}])(?:racha\s+(?:sigue\s+|queda\s+|esta\s+)?intacta|intacta\s+(?:la|mi|tu|su)\s+racha)(?![\p{L}])/u },
  { term: "desde aquí arriba", re: /(?<![\p{L}])(?:desde\s+aqui\s+arriba|casi\s+no\s+(?:te|os|le|la|lo|les)\s+veo)(?![\p{L}])/u },
  { term: "no se ve todos los días", re: /(?<![\p{L}])no\s+se\s+(?:ve|vee|veia)\s+(?:todos\s+los\s+dias|cada\s+dia)(?![\p{L}])/u },
  // Decir que hace falta un seis («Tengo que sacar otro seis», «Necesito un seis», «Me hace falta otro seis»,
  // «Tengo que volver a sacar seis», «Esto se arregla con un par de seises»). Comentar un seis que acaba de
  // salir («He sacado un seis», «¡Otro seis!») sí vale, y «seis» suelto también.
  {
    term: "necesito un seis",
    re: /(?<![\p{L}])(?:(?:necesito|necesitamos|necesitaria|necesitare|(?:me|nos)\s+hacen?\s+falta|me\s+falta|nos\s+falta|hace\s+falta)\s+(?:sacar\s+|que\s+salga\s+)?|(?:tengo|tenemos|tendre|tendria|tendriamos|he|hemos)\s+(?:que|de)\s+(?:volver\s+a\s+)?sacar\s+|se\s+arregla\s+con\s+)(?:(?:otro|otros|un|una|el|mas|dos|un\s+par\s+de)\s+)?seis(?:es)?(?![\p{L}])/u,
  },
  // Coletilla de tranquilidad retirada: «Que no cunda el pánico» y equivalentes («No cunda el pánico», «no hay
  // que entrar en pánico», «nada de pánico», «No hay motivo para alarmarse», «que nadie se alarme»). «Pánico» en
  // otro sentido («¡Qué pánico me da esa ficha!») sigue valiendo.
  {
    term: "que no cunda el pánico",
    re: /(?<![\p{L}])(?:(?:que\s+)?no\s+cunda\s+el\s+panico|no\s+(?:hay\s+que\s+|vamos\s+a\s+|debemos\s+)?entr(?:ar|emos|eis|es|e)\s+en\s+panico|(?:nada\s+de|sin)\s+panicos?|no\s+hay\s+(?:ningun\s+)?(?:motivos?|razon(?:es)?|por\s+que)\s+(?:para\s+)?alarmar(?:se|nos|os|te)|no\s+(?:os|te|se|nos)\s+alarm(?:eis|es|e|emos)|que\s+nadie\s+se\s+alarme)(?![\p{L}])/u,
  },
  // Norma de lenguaje: el dado no se personifica («el dado me quiere», «ni el dado te quiere», «el dado te ha
  // mirado mal», «el dado está de mi parte», «el dado se ha venido arriba», «el dado lo ha querido así», «¡Y el
  // dado dice…!», «le debo una al dado»…). «He sacado un seis», «buena suerte con el dado» o «el dado ha caído
  // en cinco» siguen valiendo.
  {
    term: "personificación del dado",
    re: /(?<![\p{L}])(?:dado\s+(?:no\s+)?(?:(?:me|te|le|nos|os|les|lo|la)\s+)?(?:(?:ha|han|habia)\s+)?(?:mira(?:do|ba|n)?|mire|quier(?:e|o|en)|querido|queria|quiso|odia|odiado|sonrie|sonreido|castig\p{L}*|debe|debia|ayud(?:a|ado|o|aba)|perdona\p{L}*|dice|decia|dicho|tiene\s+mania|la\s+tiene\s+jurada|esta\s+de\s+(?:mi|tu|su|nuestra|vuestra)\s+parte|se\s+(?:ha\s+)?(?:venido|vino)\s+arriba|se\s+(?:ha\s+)?pas(?:ado|o)|(?:acaba\s+de\s+)?hacer\p{L}*\s+un\s+favor|hecho\s+un\s+favor|quiere\s+pelea|se\s+(?:ha\s+)?enfad\p{L}*|se\s+rie)|(?:le\s+)?debo\s+(?:una|algo|un\s+favor)\s+al\s+dado)(?![\p{L}])/u,
  },
  { term: "soplar al dado", re: /(?<![\p{L}])sopl(?:o|a|as|amos|ar|ando|e|ado|arle)\s+(?:al|el|a\s+este|a\s+ese|a\s+mi)\s+dado(?![\p{L}])/u },
  // Comentarios gratuitos de amuletos y supersticiones: atribuir lo que pasa a un amuleto («Será el amuleto»,
  // «o eso dice mi amuleto», «me he dejado el amuleto»), el horóscopo, los calcetines de la suerte o el mal de ojo.
  // «Suerte», «mala pata» o «toco madera» siguen valiendo.
  {
    term: "será el amuleto",
    re: /(?<![\p{L}])(?:(?:sera|es|ha\s+sido|habra\s+sido|cosa|culpa|gracias|merito)\s+(?:de\s+|a\s+)?(?:el|mi|del|al)\s+amuleto|(?:dice|funciona|no\s+falla|me\s+protege|me\s+ayuda)\s+mi\s+amuleto|mi\s+amuleto\s+(?:dice|funciona|no\s+falla|me\s+protege|me\s+ayuda)|(?:dejado|dejarme|dejar|olvidado|olvidarme)\s+(?:el|mi)\s+amuleto)(?![\p{L}])/u,
  },
  // También la astrología: «hoy la luna está en mal aspecto», «los astros».
  { term: "superstición", re: /(?<![\p{L}])(?:horoscopo|calcetines\s+de\s+la\s+suerte|mal\s+de\s+ojo|(?:la\s+)?luna\s+(?:esta\s+|anda\s+)?en\s+mal\s+aspecto|los\s+astros)(?![\p{L}])/u },
  // Coletillas retiradas del catálogo por artificiales: «Todo según lo previsto» (y «todo según el plan»),
  // «Estadísticamente era inevitable», «Quien ríe el último…» y «¿Quién es el siguiente?»; y los refranes
  // retirados «La avaricia rompe el saco» y «Quien mucho corre pronto para». Y la disculpa de broma
  // («Lo siento… un poco», «Perdón, no mucho», «lo siento, de verdad… un poco»).
  {
    term: "coletilla retirada",
    re: /(?<![\p{L}])(?:todo\s+segun\s+lo\s+previsto|todo\s+segun\s+el\s+plan|estadisticamente\s+era\s+inevitable|quien\s+rie\s+el\s+ultimo|quien\s+es\s+el\s+siguiente|(?:la\s+)?avaricia\s+rompe\s+el\s+saco|quien\s+mucho\s+corre(?:\s+pronto\s+para)?)(?![\p{L}])/u,
  },
  {
    term: "disculpa de broma",
    re: /(?<![\p{L}])(?:lo\s+siento|perdon)(?:\s*,\s*\p{L}+(?:\s+\p{L}+)?)?[\s,.…]*(?:bueno[\s,.…]*)?(?:de\s+verdad[\s,.…]*)?(?:un\s+poco|no\s+mucho|no\s+tanto)(?![\p{L}])/u,
  },
  // Expresiones retiradas tras la prueba real en Preview (frases locales o de Nemotron), con sus variantes:
  // «la distancia ya es considerable», «a la abuela se la respeta», la coletilla «¿eh?», «me he quedado con la
  // ficha perdida», «ahora sí que te quedas atrás», «qué mal te lo pasas» y «me he quedado sin ficha».
  { term: "distancia considerable", re: /(?<![\p{L}])(?:(?:la\s+)?distancia\s+(?:ya\s+)?(?:es\s+)?(?:bastante\s+|muy\s+)?(?:considerable|notable)|(?:una\s+)?considerable\s+distancia)(?![\p{L}])/u },
  { term: "a la abuela se la respeta", re: /(?<![\p{L}])(?:a\s+la\s+abuela\s+se\s+(?:la|le)\s+respeta|(?:hay\s+que\s+)?respet\p{L}*\s+a\s+la\s+abuela)(?![\p{L}])/u },
  { term: "¿eh?", re: /(?:¿\s*eh\s*\?|(?<![\p{L}])eh\s*\?)/u },
  { term: "ficha perdida", re: /(?<![\p{L}])qued\p{L}*\s+con\s+(?:la|tu|su|mi|una|esa)\s+ficha\s+perdida(?![\p{L}])/u },
  { term: "te quedas atrás", re: /(?<![\p{L}])(?:(?:ahora|ya)\s+(?:si\s+)?(?:que\s+)?)?te\s+quedas\s+atras(?![\p{L}])/u },
  { term: "qué mal te lo pasas", re: /(?<![\p{L}])(?:que\s+mal\s+te\s+lo\s+pas\p{L}*|te\s+lo\s+(?:estas\s+)?pas\p{L}*\s+(?:muy\s+)?(?:mal|fatal)|lo\s+estas\s+pasando\s+(?:muy\s+)?(?:mal|fatal))(?![\p{L}])/u },
  { term: "me he quedado sin ficha", re: /(?<![\p{L}])(?:me\s+)?(?:he\s+)?qued(?:ado|o|e|ando)\s+sin\s+(?:(?:mi|esa|la|una)\s+)?fichas?(?![\p{L}])/u },
  // Contar una captura como «tener» o «quedarse con» la ficha del rival: «Tengo la tuya», «Ya tengo tu ficha»,
  // «Me he quedado con la tuya», «me quedé con su ficha», «quedarme con la ficha de Brava». Y el elogio
  // «Bien visto». Siguen valiendo «Tengo otra ficha en meta», «Me he quedado con una ficha en casa» o
  // «Tienes mi ficha a tiro».
  {
    term: "tener la ficha",
    re: /(?<![\p{L}])(?:ya\s+)?(?:tengo|tenemos|tienes|tiene)\s+(?:la\s+(?:tuya|suya|vuestra|mia)|(?:tu|su|vuestra|mi|esa)\s+ficha)(?![\p{L}])(?!\s+a\s+tiro)/u,
  },
  {
    term: "quedarse con la ficha",
    re: /(?<![\p{L}])qued\p{L}*\s+con\s+(?:la\s+(?:tuya|suya|vuestra|mia)|las\s+(?:tuyas|suyas|mias)|la\s+ficha(?!\s+en(?![\p{L}]))|las\s+fichas(?!\s+en(?![\p{L}]))|(?:tu|tus|su|sus|vuestra|vuestras|esa|esas|mi|mis)\s+fichas?)(?![\p{L}])/u,
  },
  { term: "bien visto", re: /(?<![\p{L}])bien\s+visto(?![\p{L}])/u },
  // «¡He llegado a casa!»: el final es la meta; a casa vuelve una ficha comida.
  { term: "he llegado a casa", re: /(?<![\p{L}])lleg(?:ado|ue|o|a|as|amos|aron|ar)\s+a\s+casa(?![\p{L}])/u },
  // «¡Vamos por todas!», «¡A por todas!», «voy a por todas».
  { term: "vamos por todas", re: /(?<![\p{L}])(?:(?:vamos|voy|vais|van)\s+(?:a\s+)?|a\s+)por\s+todas(?![\p{L}])(?!\s+partes)/u },
  // Amenaza vaga, variante de la coletilla retirada «¿Quién es el siguiente?».
  { term: "ojo con el siguiente", re: /(?<![\p{L}])ojo\s+con\s+(?:el|la)\s+siguiente(?![\p{L}])/u },
  // Explicación táctica inventada de una captura («Previsible. Ha dejado esa ficha sola.», «esa ficha era la
  // única que tenía a salvo»): el chat no sabe si la ficha estaba sola, protegida o a salvo.
  {
    term: "explicación táctica",
    re: /(?<![\p{L}])(?:(?:dej\p{L}*|tenia|tenias|estaba|estaban)\s+(?:(?:esa|la|tu|su|mi|una)\s+)?ficha\s+(?:sola|sin\s+(?:cubrir|proteger|proteccion)|desprotegida|expuesta|al\s+descubierto)|(?:la\s+)?unica\s+que\s+(?:tenia|tenias|tenia\s+usted)\s+a\s+salvo)(?![\p{L}])/u,
  },
  // Revisión de los mensajes reales de Preview: «{rival} sigue perdido/a» (se dice «va perdiendo»), «No volverá a
  // ocurrir» y «Tengo que esperar mi turno», con sus variantes equivalentes.
  { term: "sigue perdido", re: /(?<![\p{L}])(?:sigue|sigues|sigo|esta|estas|estoy|anda|andas|ando)\s+(?:muy\s+|un\s+poco\s+|bastante\s+|ya\s+)?perdid[oa]s?(?![\p{L}])/u },
  {
    term: "no volverá a ocurrir",
    re: /(?<![\p{L}])(?:no\s+(?:volvera|va\s+a\s+volver|vuelve)\s+a\s+(?:ocurrir|pasar|suceder)|no\s+se\s+(?:repetira|va\s+a\s+repetir)|no\s+(?:ocurrira|pasara|sucedera)\s+mas)(?![\p{L}])/u,
  },
  { term: "esperar mi turno", re: /(?<![\p{L}])esper\p{L}*\s+(?:a\s+)?(?:mi|el)\s+turno(?![\p{L}])/u },
  // «Me la he comido» (y «…y ya va siendo hora»): la captura contada con «me la(s)» en primera persona, que es
  // ambigua («comérsela» también es cargar con algo). Siguen valiendo «Te comí», «Te la he comido» (el «te»
  // señala a la víctima), «Le comí», «Me comiste», «¡Me la has comido!» y «Me como su ficha».
  {
    term: "me la he comido",
    re: /(?<![\p{L}])(?:(?:me|nos)\s+(?:la|las)\s+(?:(?:he|hemos|habia|habiamos)\s+comido|comi|comimos|como|comemos|comere|comeremos|comeria|acabo\s+de\s+comer|acabamos\s+de\s+comer|voy\s+a\s+comer|vamos\s+a\s+comer)|comermelas?|comernoslas?)(?![\p{L}])/u,
  },
  // «Ya va siendo hora» y sus variantes («va/iba siendo hora», «ya era hora», «ya es hora»).
  { term: "ya va siendo hora", re: /(?<![\p{L}])(?:(?:ya\s+)?(?:va|iba)\s+siendo\s+hora|ya\s+(?:era|es)\s+hora)(?![\p{L}])/u },
  // Narrar la jugada y sus consecuencias en lugar de comentarla («Le he comido una ficha a Brava y vuelve a su
  // casa», «esa ficha vuelve a su casa»). Siguen valiendo las reacciones cortas: «¡Te comí! A casa.», «¡A casa,
  // Chispa!», «Vuelve a casa, Chispa», «Brava, le he comido una ficha».
  {
    term: "narración de la jugada",
    re: /(?<![\p{L}])(?:(?:vuelve|vuelven|regresa|regresan|volvera|volveran|se\s+va|se\s+van)\s+a\s+su\s+casa|(?:comid[oa]s?|comi|como|comio|comiste|pillad[oa]s?|pille|pillo|capturad[oa]s?|capture|capturo)(?![\p{L}])[^.!?…]*?\s+y\s+(?:(?:su|tu|mi|la|esa)\s+ficha\s+)?(?:vuelve|vuelves|vuelvo|regresa|regresas|se\s+va|te\s+vas|me\s+voy|va|vas|voy|volvera|volveras)\s+a\s+(?:su\s+|tu\s+|mi\s+)?(?:casa|casita|la\s+salida))(?![\p{L}])/u,
  },
  // «Eso me viene muy bien» y «Me he quedado solo en la meta», con sus variantes.
  {
    term: "me viene muy bien",
    re: /(?<![\p{L}])me\s+(?:viene|vino|ha\s+venido|vendra|va\s+a\s+venir)\s+(?:muy\s+bien|bien|genial|de\s+perlas|de\s+maravilla|estupendamente|que\s+ni\s+pintad[oa])(?![\p{L}])/u,
  },
  { term: "solo en la meta", re: /(?<![\p{L}])(?:me\s+(?:he\s+)?qued\p{L}*|estoy|sigo)\s+(?:yo\s+)?sol[oa]s?\s+en\s+la\s+meta(?![\p{L}])/u },
  // «¡Me he dado el gustazo de comerte la ficha!» y sus variantes («qué gustazo», «darme el gusto de…»).
  { term: "gustazo", re: /(?<![\p{L}])(?:gustazo|(?:me\s+(?:he\s+dado|doy|di|voy\s+a\s+dar)|darme)\s+el\s+gusto\s+de)(?![\p{L}])/u },
  // «Le he comido la ficha a Brava» dicho a la propia Brava: se dice «Le he comido su ficha, Brava».
  {
    term: "ficha a + nombre",
    re: /(?<![\p{L}])(?:comid[oa]|comi|comio|pillad[oa]|pille|capturad[oa]|capture)\s+(?:la|su|tu|una)\s+ficha\s+a\s+(?:la\s+abuela|abuela\s+pilar|pilar|don\s+ernesto|ernesto|brava|chispa)(?![\p{L}])/u,
  },
  // «No ha salido como esperaba» y sus variantes de persona y tiempo («no me ha salido como esperaba», «no salió
  // como pensaba», «no ha ido como esperábamos»…). «Ha salido como pensaba», sin negar, sigue valiendo.
  {
    term: "no ha salido como esperaba",
    re: /(?<![\p{L}])no\s+(?:me\s+|te\s+|le\s+|nos\s+|os\s+|les\s+)?(?:(?:ha|han|habia|habian|ha\s+terminado\s+de)\s+)?(?:salido|salio|salieron|sale|ido|fue|fueron|va)\s+como\s+(?:yo\s+)?(?:esperaba|esperabas|esperabamos|esperaban|esperaria|queria|querias|queriamos|pensaba|pensabas|pensabamos|creia|tenia\s+previsto|habia\s+previsto|preveia|calculaba|habia\s+calculado|imaginaba)(?![\p{L}])/u,
  },
  // «… y sin correr nada» (y «sin correr nada», «y sin correr» al final de la frase). «Sin correr, pero sin
  // parar» sigue valiendo.
  { term: "sin correr nada", re: /(?<![\p{L}])(?:(?:y\s+)?sin\s+correr\s+(?:nada|nadita|ni\s+(?:un\s+)?poco)|y\s+sin\s+correr(?=\s*(?:$|[.!?,;…])))(?![\p{L}])/u },
  // «Se la ha jugado con el dado», con cualquier persona y tiempo («me la juego con el dado», «te la jugaste con
  // los dados», «jugársela con el dado»).
  {
    term: "jugársela con el dado",
    re: /(?<![\p{L}])(?:(?:me|te|se|nos|os)\s+las?\s+(?:(?:he|has|ha|hemos|habeis|han|voy\s+a|vas\s+a|va\s+a)\s+)?j(?:ug|ueg)\p{L}*|jugar(?:me|te|se|nos|os)las?|jugandos(?:e|ela|elas))\s+con\s+(?:el|los|un)\s+dados?(?![\p{L}])/u,
  },
  // «Segunda vez en nada» y sus variantes («otra vez en nada», «tres veces en nada», «dos en nada», «dos capturas en
  // nada de tiempo»). «En nada te alcanzo» o «esto no queda en nada», sin cifra ni ordinal delante, siguen valiendo.
  {
    term: "vez en nada",
    re: /(?<![\p{L}])(?:(?:primera|segunda|tercera|cuarta|quinta|otra)\s+vez|(?:dos|tres|cuatro|cinco|seis|siete|ocho|\d+)(?:\s+(?:veces|capturas|fichas))?)\s+en\s+nada(?![\p{L}])/u,
  },
  // «Lleva dos perdidas» y sus variantes de persona y formulación («llevo tres perdidas», «ya van dos perdidas», «dos
  // fichas perdidas»). «Dos tiradas perdidas» o «he perdido dos fichas» no son esta expresión.
  { term: "lleva dos perdidas", re: /(?<![\p{L}])(?:dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s+(?:fichas\s+)?perdid[oa]s(?![\p{L}])/u },
  // «(Se lleva) la captura y yo sigo sin ella» y sus variantes («yo sigo sin ninguna», «sigo sin capturar», «me quedo
  // sin comer ninguna», «sigue sin captura»). «Sigo sin sacar un cinco» o «me quedo sin turno» siguen valiendo.
  {
    term: "sigo sin captura",
    re: /(?<![\p{L}])(?:(?:la|una)\s+captura\s+y\s+yo\s+(?:sigo\s+|me\s+quedo\s+)?sin|(?:sigo|seguimos|sigues|sigue|siguen|me\s+quedo|me\s+he\s+quedado)\s+sin\s+(?:ella|ninguna(?:\s+captura)?|capturas?|capturar|comer(?:me)?(?:\s+(?:nada|ninguna|ni\s+una))?))(?![\p{L}])/u,
  },
  { term: "racha + número", re: STREAK_NUMBER },
  {
    term: "mantengo la ventaja",
    re: /(?<![\p{L}])(?:mantengo|mantenemos|conservo|conservamos|sigo\s+manteniendo|sigo\s+conservando)\s+(?:la|mi|esta|nuestra)\s+ventaja(?![\p{L}])/u,
  },
];
/**
 * Coletilla que cuenta las fichas perdidas del rival en segunda persona: «He comido tu ficha y ya vas dos»,
 * «y ya vais tres», «ya vas por la segunda». Sobra: la frase ya dice lo que ha pasado. (Las cifras de
 * capturas con sujeto, «llevas dos», «me has comido tres fichas», las comprueba `checkCountClaims`.)
 */
const YOU_ARE_AT =
  /(?<![\p{L}])(?:vas|vais)\s+(?:ya\s+)?(?:por\s+la\s+)?(?:\d+|una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|segunda|tercera|cuarta|quinta)(?![\p{L}\p{N}])(?!\s+(?:casillas?|por\s+delante|por\s+detras))/u;
/**
 * Distancias hasta la meta: los personajes no calculan ni anuncian cuántas casillas les quedan («Y ahora a la
 * meta en seis», «me quedan cinco casillas», «estoy a tres de la meta»). Pueden celebrar que han llegado o que
 * tienen una ficha cerca, pero sin números.
 */
const NUMBER_WORD = String.raw`(?:\d+|una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte)`;
/** «Voy primero/a»: retirado; `checkGameTalk` ya lo rechaza, y así tampoco se cita en el prompt. */
const OWN_RANK = /(?<![\p{L}])voy\s+(?:el\s+|la\s+)?primer[oa](?![\p{L}])(?!\s+(?:vez|ficha|fichas|casilla|tirada))/u;
const GOAL_DISTANCE: readonly RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}])(?:a|hasta|para)\s+(?:la\s+)?meta\s+(?:en|con|a)\s+(?:solo\s+)?(?:un\s+)?${NUMBER_WORD}(?![\p{L}\p{N}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])${NUMBER_WORD}\s+(?:casillas?\s+)?(?:de|para|hasta)\s+(?:la\s+)?meta(?![\p{L}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])(?:me\s+|le\s+|te\s+)?(?:quedan?|faltan?)\s+(?:solo\s+)?${NUMBER_WORD}\s+casillas?(?![\p{L}])`, "u"),
  // Lo que falta, contado con el dado: «Con un seis, a la meta», «otro cinco y a la meta».
  new RegExp(String.raw`(?<![\p{L}])(?:con|necesito|me\s+basta\s+con)\s+(?:un|otro)\s+${NUMBER_WORD}\s*,?\s+(?:y\s+)?(?:a\s+la|llego\s+a\s+la|entro\s+en\s+la|en\s+la|estoy\s+en\s+la)\s+meta(?![\p{L}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])(?:un|otro)\s+${NUMBER_WORD}\s+y\s+(?:a\s+la|en\s+la|llego\s+a\s+la|entro\s+en\s+la)\s+meta(?![\p{L}])`, "u"),
];
/**
 * «Tirarse un número» («me tiré un cuatro», «se tiró un seis»): no es como se dice. Lo natural es «he
 * sacado un cuatro» o «me ha salido un seis». «He tirado y me ha salido un seis» sí vale.
 */
const DICE_REFLEXIVE = /(?<![\p{L}])(?:me|te|se|nos|os)\s+(?:(?:he|has|ha|hemos|habeis|han)\s+)?tir\p{L}*\s+(?:(?:un|el|otro)\s+)?(?:uno|dos|tres|cuatro|cinco|seis|\d+)(?![\p{L}\p{N}])/u;
/** En una captura, «no me la quites» no tiene sentido: la ficha ya se ha perdido (o es la que se come). */
const KEEP_IT = /(?<![\p{L}])no\s+me\s+la\s+quites(?![\p{L}])/u;
/**
 * Objetivo con un ordinal y sin sustantivo («¡Vamos por la quinta!», «a por la tercera»): supone un recuento
 * de capturas que no está en los datos. Con sustantivo («la tercera vez», «la segunda captura») ya lo
 * comprueba `checkCountClaims`.
 */
const ORDINAL_GOAL = new RegExp(
  `(?<![\\p{L}])(?:a\\s+)?por\\s+la\\s+(${Object.keys(ORDINALS).filter((o) => o.endsWith("a")).join("|")})(?![\\p{L}])(?!\\s+(?:vez|captura|ficha))`,
  "u",
);

/**
 * Naturalidad (regla nueva tras la partida de Preview con «¡Dadme ese seis, por favor!», «Otro golpe,
 * Chispa», «¡Vamos por la quinta!» y «¡Mía! No me la quites»): se rechaza pedirle algo al dado, «golpe» y
 * «da sus frutos», y «no me la quites» en una captura (`expresión poco natural`); y un objetivo con un
 * ordinal sin respaldo (`afirmación no respaldada`). Va la última del conjunto: no cambia el motivo de
 * ningún rechazo anterior.
 */
// ── Atribuir pensamientos o emociones a otros ─────────────────────────────────────────────────────

/**
 * Atribuir a otro jugador pensamientos, expectativas, intenciones o emociones que nada respalda: el chat solo
 * sabe lo que ha pasado en el tablero. «¡Vaya, y tú pensando que tenías la partida ganada!», «te creías la
 * ganadora», «ibas a por mí», «estás nerviosa», «te has asustado», «pensaba usted que…». Solo segunda persona
 * (también de usted): lo que dice de sí mismo quien habla («creía que…», «estoy contenta») sí vale, igual que
 * las exhortaciones («no te confíes», «tú tranquila») y «te veo venir».
 */
const ATTRIBUTION: readonly { term: string; re: RegExp }[] = [
  {
    term: "atribuye pensamientos",
    re: /(?<![\p{L}])(?:(?:y\s+)?tu\s+pensando|pensabas|pensaste|creias|creiste|te\s+creias|te\s+creiste|te\s+lo\s+creias|esperabas|imaginabas|te\s+imaginabas|te\s+veias|confiabas|tenias\s+(?:la\s+partida|el\s+juego)\s+ganad[oa]|(?:pensaba|creia|esperaba|imaginaba)\s+usted|usted\s+(?:pensaba|creia|esperaba|imaginaba|se\s+creia))(?![\p{L}])/u,
  },
  {
    term: "atribuye intenciones",
    // Dentro de una creencia propia («Creía que me ibas a comer») no se atribuye nada: lo cuenta quien habla.
    re: /(?<![\p{L}])(?<!(?:creia|pensaba|crei|pense|sabia|imaginaba|temia)\s+que\s+(?:(?:me|te|lo|la|nos)\s+)?)(?:querias|pretendias|ibas\s+a|tenias\s+pensado|(?:queria|pretendia)\s+usted|usted\s+(?:queria|pretendia|iba\s+a))(?![\p{L}])/u,
  },
  {
    term: "atribuye emociones",
    re: /(?<![\p{L}])(?:(?:estas|estaras|te\s+veo|te\s+noto|se\s+te\s+ve|se\s+te\s+nota|pareces|esta\s+usted|parece\s+usted|se\s+le\s+ve)\s+(?:muy\s+|un\s+poco\s+|algo\s+|bastante\s+|tan\s+)?(?:content[oa]|nervios[oa]|asustad[oa]|preocupad[oa]|enfadad[oa]|mosquead[oa]|picad[oa]|triste|celos[oa]|feliz|confiad[oa]|desesperad[oa]|frustrad[oa]|agobiad[oa]|rabios[oa]|molest[oa]|ilusionad[oa])|te\s+has\s+(?:asustado|enfadado|mosqueado|picado|agobiado|puesto\s+nervios[oa]))(?![\p{L}])/u,
  },
];

/**
 * «¡Abre la barrera!» y sus variantes solo tienen sentido cuando una barrera de ese rival corta el paso de
 * verdad: el director solo ofrece ese tipo de intervención (`blockade_complaint`) con un bloqueo real
 * (`blockedByRivalBarrier`). En cualquier otra intervención, pedir que abran una barrera se rechaza.
 */
const BARRIER_REQUEST =
  /(?<![\p{L}])(?:(?:abre|abra|abrid|abran|quita|quite|quitad|deshaz)\s+(?:usted\s+)?(?:la|esa|tu|su|vuestra)\s+barrera|barrera\s+(?:no\s+me\s+deja\s+pasar|me\s+(?:cierra|corta|tapa)\s+el\s+paso))(?![\p{L}])/u;

function checkBarrierTalk(text: string, request: ChatWriteRequest): QualityIssue | null {
  if (request.utterance.kind === "blockade_complaint") return null;
  return BARRIER_REQUEST.test(normalize(text)) ? { reason: "afirmación no respaldada", term: "barrera sin bloqueo" } : null;
}

/**
 * Una réplica contesta al mensaje anterior; no lo repite desde el otro lado. Si, quitando los nombres y las
 * palabras de la propia captura (comer, pillar, ficha, pronombres…), no queda nada, la réplica no dice nada
 * nuevo: «Te comí la ficha» como respuesta a «Me has comido una ficha». «Sí, te comí la ficha», «Te comí la
 * ficha, jeje» o «¡A casa!» sí contestan.
 */
const ECHO_WORDS = new Set([
  "te", "me", "le", "la", "lo", "las", "los", "su", "sus", "tu", "tus", "mi", "mis", "una", "un", "el", "ficha", "fichas",
  "he", "has", "ha", "hemos", "han", "usted", "comi", "comido", "comida", "comiste", "comio", "como", "comes", "come", "comer",
  "pille", "pillado", "pillaste", "pillo", "capture", "capturado", "capturaste", "capturo",
  "brava", "don", "ernesto", "abuela", "pilar", "chispa",
]);

function checkReplyEcho(text: string, request: ChatWriteRequest): QualityIssue | null {
  if (request.utterance.replyTo === null || !request.replyToText) return null;
  const words = normalize(text).match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.every((w) => ECHO_WORDS.has(w)) ? { reason: "repite el mensaje anterior", term: "eco" } : null;
}

function checkAttribution(text: string): QualityIssue | null {
  const t = normalize(text);
  for (const { term, re } of ATTRIBUTION) if (re.test(t)) return { reason: "afirmación no respaldada", term };
  return null;
}

// ── Tratamiento según quien habla ──────────────────────────────────────────────────────────────────

const CHISPA_ID = "ai-blue";
const BRAVA_ID = "ai-pink";
const SEÑORES = /(?<![\p{L}])señores(?![\p{L}])/u;
const HIJOS = /(?<![\p{L}])hijos(?![\p{L}])/u;
/** Segunda persona del singular (sin tildes): «hijos» dicho a una sola persona («Ay, hijos, me has comido»). */
const SINGULAR_YOU = /(?<![\p{L}])(?:tu|te|ti|contigo|has|eres|estas|tienes|vas|llevas|pierdes|sacas|tiras|comes|pillas|comiste|pillaste|sacaste|tiraste|ganaste)(?![\p{L}])/u;
const BRAVA_LOST_ONE = /me\s+has\s+comido\s+una\s+ficha/iu;

/**
 * Tratamiento:
 * - «señores», para dirigirse a todos, es exclusivo de Chispa (y solo de vez en cuando: no está en su catálogo).
 * - Abuela Pilar dice «hijos» al grupo, nunca a una sola persona: en la misma frase no puede haber marcas de
 *   segunda persona del singular (a uno solo le dice «cariño», que no se comprueba aquí).
 * - Brava dice «¡Me has comido una ficha!» con exclamaciones (la frase va entre «¡» y «!»).
 */
function checkAddress(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  const speaker = request.utterance.speaker;
  if (speaker !== CHISPA_ID && SEÑORES.test(t)) return { reason: "expresión poco natural", term: "señores (solo Chispa)" };
  if (speaker === PILAR_ID) {
    for (const sentence of t.split(/[.!?…]+/u)) {
      if (HIJOS.test(sentence) && SINGULAR_YOU.test(sentence)) return { reason: "expresión poco natural", term: "hijos a una sola persona" };
    }
  }
  if (speaker === BRAVA_ID) {
    const match = BRAVA_LOST_ONE.exec(text);
    if (match) {
      const before = text.slice(0, match.index);
      const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("…"));
      const opened = before.slice(start + 1).includes("¡");
      const closed = /^[^.?…!]*!/u.test(text.slice(match.index + match[0].length));
      if (!opened || !closed) return { reason: "expresión poco natural", term: "sin exclamaciones (Brava)" };
    }
  }
  return null;
}

function checkNaturalness(text: string, request: ChatWriteRequest): QualityIssue | null {
  const address = checkAddress(text, request);
  if (address) return address;
  const t = normalize(text);
  if (DICE_REQUEST.some((re) => re.test(t))) return { reason: "expresión poco natural", term: "petición al dado" };
  if (DICE_REFLEXIVE.test(t)) return { reason: "expresión poco natural", term: "tirarse un número" };
  for (const { term, re } of UNNATURAL) if (re.test(t)) return { reason: "expresión poco natural", term };
  if (CAPTURE_TRIGGERS.has(request.utterance.trigger) && KEEP_IT.test(t)) return { reason: "expresión poco natural", term: "no me la quites" };
  if (GOAL_DISTANCE.some((re) => re.test(t))) return { reason: "afirmación no respaldada", term: "distancia a la meta" };
  if (YOU_ARE_AT.test(t)) return { reason: "expresión poco natural", term: "ya vas dos" };
  const ordinal = ORDINAL_GOAL.exec(t);
  if (ordinal) return { reason: "afirmación no respaldada", term: `objetivo ${ordinal[1]}` };
  return null;
}

// ── Dirección de la captura ───────────────────────────────────────────────────────────────────────

/**
 * Quien habla y su papel en la captura de ESTA versión salen de los datos reales del evento: los hechos
 * de captura (`captures.selfRole`, en mensajes y réplicas) o, si faltan, el tipo de intervención (las de
 * quien captura son `capture_boast` y `streak_boast`; las de quien la pierde, `capture_lament` y
 * `streak_lament`). Fuera de capturas y rachas no hay dirección que comprobar.
 */
function captureRole(request: ChatWriteRequest): "by" | "victim" | null {
  const { utterance } = request;
  if (!["capture", "capture_streak", "bad_streak"].includes(utterance.trigger)) return null;
  if (utterance.captures) return utterance.captures.selfRole;
  if (utterance.kind === "capture_boast" || utterance.kind === "streak_boast") return "by";
  if (utterance.kind === "capture_lament" || utterance.kind === "streak_lament") return "victim";
  return null;
}

/** Quien habla PIERDE la ficha (también «me la has comido»): «me comiste», «me has comido», «me ha comido usted», «X se come mi ficha». */
const SPEAKER_LOST: readonly RegExp[] = [
  /(?<![\p{L}])me\s+(?:(?:la|las)\s+)?(?:(?:has|ha|habeis|han)\s+)?(?:comid[oa]|comiste|comio|comisteis|comieron|comes|come|comeis|comen|pillad[oa]|pillaste|pillo|pillas|pilla|cazad[oa]|cazaste|cazo|cazas|caza|capturad[oa]|capturaste|capturo|capturas|captura|mandad[oa]|mandaste|mando)(?![\p{L}])/u,
  /(?<![\p{L}])(?:(?:se\s+)?(?:(?:has|ha|han)\s+)?(?:comid[oa]|comiste|comio|come|comes)|se\s+(?:ha\s+)?(?:llevado|lleva))\s+(?:a\s+)?mi\s+ficha(?![\p{L}])/u,
];
/**
 * Quien habla CAPTURA: «te comí», «le he comido», «te la he comido», «se la he comido» (de usted), «he comido
 * tu/su ficha», «me como tu ficha».
 */
const SPEAKER_CAPTURED: readonly RegExp[] = [
  /(?<![\p{L}])se\s+(?:la|las)\s+(?:(?:he|hemos)\s+comido|comi|comimos)(?![\p{L}])/u,
  /(?<![\p{L}])(?:te|le|os|les)\s+(?:(?:la|las)\s+)?(?:(?:he|hemos)\s+)?(?:comi|comido|como|pille|pillado|cace|cazado|capture|capturado|mande|mandado)(?![\p{L}])/u,
  /(?<![\p{L}])(?:(?:me\s+)?(?:he|hemos)\s+comido|(?:me\s+)?comi|me\s+como)\s+(?:a\s+)?(?:tu|su|vuestra)\s+ficha(?![\p{L}])/u,
];
/** Disculpas («lo siento», «perdona», «disculpe»…). Por sí solas no contradicen a nadie: ver `CAPTURE_EXCUSE`. */
const APOLOGY = /(?<![\p{L}])(?:lo\s+siento|perdon|perdona|perdone|disculpa|disculpe)(?![\p{L}])/u;
/**
 * Justificaciones de quien ha decidido la captura: «era la mejor jugada», «no tenía otra opción», «tenía
 * que hacerlo», «nada personal», «no me lo tengas en cuenta». Junto a una disculpa, atribuyen a quien habla
 * la decisión de capturar («Lo siento, Abuela Pilar. Era la mejor jugada»). Sin disculpa son ambiguas
 * («Era la mejor jugada» puede ser un elogio al rival), así que solas no cuentan.
 */
const CAPTURE_EXCUSE =
  /(?<![\p{L}])(?:(?:era|fue|es)\s+(?:la|mi)\s+(?:mejor|unica)\s+(?:jugada|opcion|salida)|no\s+(?:tenia|tuve|habia|hubo|me\s+quedaba)\s+(?:otra|otra\s+opcion|mas\s+remedio|alternativa|eleccion)|(?:tenia|tuve)\s+que\s+hacerlo|(?:nada|no\s+es|no\s+era)\s+personal|no\s+me\s+lo\s+(?:tengas|tenga|tengais)\s+en\s+cuenta|no\s+podia\s+dejarla?\s+pasar|estaba\s+a\s+tiro)(?![\p{L}])/u;

/**
 * La frase debe hablar desde el lado de quien habla en la captura de ESTA versión. Si captura, no puede
 * decir que le han comido ni contar la captura al revés; si la pierde, no puede decir que ha comido al
 * rival, ni disculparse justificando una captura que no ha hecho (`CAPTURE_EXCUSE`); una disculpa natural
 * («Perdona, pero la próxima es mía», «Lo siento, hoy no hay suerte») sí vale. No mira el historial: una
 * frase sobre esta captura con la dirección cambiada se rechaza aunque antes hubiera capturas en el otro
 * sentido (así no se confunde quién comió a quién).
 */
function checkCaptureDirection(text: string, request: ChatWriteRequest): QualityIssue | null {
  const role = captureRole(request);
  if (!role) return null;
  const t = normalize(text);
  if (role === "by") {
    for (const re of SPEAKER_LOST) {
      const match = re.exec(t);
      if (match) return { reason: "contradice quién captura", term: `pierde la ficha: ${match[0].replace(/\s+/g, " ")}` };
    }
    return null;
  }
  for (const re of SPEAKER_CAPTURED) {
    const match = re.exec(t);
    if (match) return { reason: "contradice quién captura", term: `captura: ${match[0].replace(/\s+/g, " ")}` };
  }
  // Disculparse solo contradice el evento si además se justifica una captura (la decisión es del rival).
  const apology = APOLOGY.exec(t);
  const excuse = apology ? CAPTURE_EXCUSE.exec(t) : null;
  return excuse ? { reason: "contradice quién captura", term: `disculpa de quien captura: ${excuse[0].replace(/\s+/g, " ")}` } : null;
}

// ── Hablar de la captura, no de otra cosa ─────────────────────────────────────────────────────────

/** Otros acontecimientos: llegar a la meta, sacar una ficha de casa. */
const OTHER_EVENT: readonly { term: string; re: RegExp }[] = [
  { term: "meta", re: /(?<![\p{L}])meta(?![\p{L}])/u },
  { term: "sacar ficha", re: /(?<![\p{L}])(?:sac\p{L}*\s+(?:otra|una|la|mi|las|mis)\s+fichas?|salir\s+de\s+casa|sal\p{L}*\s+de\s+casa)(?![\p{L}])/u },
];
/**
 * Buena suerte propia («qué suerte», «tengo suerte», «estoy de suerte»): no es una reacción de quien acaba
 * de perder una ficha. «Mala suerte», «qué suerte tienes» (protesta por la suerte del rival) sí lo son.
 */
const OWN_GOOD_LUCK =
  /(?<![\p{L}])(?:(?<!mala\s)(?<!poca\s)que\s+suerte(?!\s+(?:tienes|tiene|teneis|has\s+tenido|ha\s+tenido|la\s+tuya|la\s+suya|la\s+vuestra))|tengo\s+suerte|estoy\s+de\s+suerte|me\s+sonrie\s+la\s+suerte)(?![\p{L}])/u;

/**
 * En una captura (mensaje o réplica, también en rachas), la frase debe reaccionar a ESA captura: nada sobre la
 * meta ni sobre sacar fichas (Abuela Pilar, tras «Te he comido» de Brava: «Tengo otra en meta, qué suerte»), y
 * quien pierde la ficha no celebra su buena suerte. Va después de la comprobación de la dirección.
 */
function checkCaptureTopic(text: string, request: ChatWriteRequest): QualityIssue | null {
  const role = captureRole(request);
  if (!role) return null;
  const t = normalize(text);
  for (const { term, re } of OTHER_EVENT) if (re.test(t)) return { reason: "no responde a la captura", term };
  if (role === "victim" && OWN_GOOD_LUCK.test(t)) return { reason: "no responde a la captura", term: "buena suerte propia" };
  // En una captura simple quien la pierde sabe quién se la ha comido: nada de «me han comido» impersonal (en
  // una mala racha sí puede hablar de varias capturas de distintos rivales).
  if (role === "victim" && request.utterance.trigger === "capture" && /(?<![\p{L}])me\s+han\s+(?:comido|pillado|cazado|capturado|mandado)(?![\p{L}])/u.test(t)) {
    return { reason: "no responde a la captura", term: "me han comido (impersonal)" };
  }
  return null;
}

// ── Capturas repetidas ────────────────────────────────────────────────────────────────────────────

/**
 * Afirmar que una captura se repite («me comiste la ficha de nuevo», «otra vez me pillas», «me comiste
 * otra ficha», «me vuelves a comer», «te he comido otra vez») solo es cierto si esa pareja, en esa
 * dirección, ya lleva al menos dos capturas en la ventana (incluida la de ahora). «me» (o «nos») es una
 * captura del rival a quien habla; «te», «le», «la», «lo», «os», una de quien habla al rival. Sin hechos
 * completos (`captures`), no es verificable y se rechaza. No cuentan «de nuevo» ni «otra vez» lejos del
 * verbo de captura («¡Te pillé! A empezar de nuevo», «¿Otra vez?»).
 */
const REPEAT_MARK = String.raw`(?:de\s+nuevo|otra\s+vez|una\s+vez\s+mas)`;
const CAPTURE_VERB = String.raw`(?:comid[oa]s?|comiste|comio|comi|comes|come|como|comer|pillad[oa]s?|pillaste|pillo|pille|pillas|pilla|pillar|cazad[oa]s?|cazaste|cazo|cace|cazas|caza|cazar|capturad[oa]s?|capturaste|capturo|capture|capturas|captura|capturar|mandad[oa]s?|mandaste|mando|mande|mandas|manda|mandar)`;
const CAPTURE_OBJECT = String.raw`(me|nos|te|le|la|lo|os)`;
const HAVE = String.raw`(?:(?:has|ha|he|hemos|habeis|han)\s+)?`;
const AFTER_VERB = String.raw`(?:\s+(?:la|una|mi|tu|su|esa)\s+ficha)?(?:\s+a\s+(?:casa|casita))?`;
const REPEATED_CAPTURE: readonly RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}])${CAPTURE_OBJECT}\s+${HAVE}${CAPTURE_VERB}${AFTER_VERB}\s*,?\s+${REPEAT_MARK}(?![\p{L}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])${REPEAT_MARK}\s*,?\s+${CAPTURE_OBJECT}\s+${HAVE}${CAPTURE_VERB}(?![\p{L}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])${CAPTURE_OBJECT}\s+${HAVE}${CAPTURE_VERB}\s+otra\s+ficha(?![\p{L}])`, "u"),
  new RegExp(String.raw`(?<![\p{L}])${CAPTURE_OBJECT}\s+(?:vuelves|vuelve|vuelvo|has\s+vuelto|ha\s+vuelto|he\s+vuelto)\s+a\s+(?:comer|pillar|cazar|capturar|mandar)(?![\p{L}])`, "u"),
];

function checkRepeatedCapture(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  const facts = request.utterance.captures;
  for (const re of REPEATED_CAPTURE) {
    const match = re.exec(t);
    if (!match) continue;
    const towardsSpeaker = match[1] === "me" || match[1] === "nos";
    const pair = facts?.history === "complete" ? (towardsSpeaker ? facts.rivalOnSelf : facts.selfOnRival) : null;
    if (!pair || pair.count < 2) return { reason: "afirmación no respaldada", term: "captura repetida" };
  }
  return null;
}

// ── Diminutivos ────────────────────────────────────────────────────────────────────────────────────

/**
 * Diminutivos (sin tildes, tras `normalize`; lista cerrada de raíces para no confundirlos con palabras
 * normales: «pasillo», «bonita», «solicita» no lo son): «fichita», «casita», «poquito», «despacito»,
 * «cariñito», «hijito», «abuelita», «ratito», «dadito», «cerquita», «pobrecito», «chiquillo»…
 */
const DIMINUTIVE =
  /(?<![\p{L}])((?:fich|cas|cos|poqu|despac|cariñ|abuel|hij|niñ|rat|moment|cuidad|tranquil|rapid|cerqu|sol|junt|pequeñ|dad|turn|tirad|met|pas|suav|lent|gord|pobrec|vuel|ahor)(?:it|ic)(?:o|a|os|as)|chiquill(?:o|a|os|as))(?![\p{L}])/gu;
/** Frases hechas de Abuela Pilar que se le permiten (refranes de toda la vida). */
const PILAR_SET_PHRASES = /despacito\s+y\s+buena\s+letra|poquito\s+a\s+poco/gu;
const PILAR_ID = "ai-green";

/**
 * Primer diminutivo no permitido, o `null`. Ningún personaje usa diminutivos, salvo Abuela Pilar: «casita»
 * solo cuando una ficha vuelve a casa (una captura o una racha), y sus dos frases hechas («despacito y
 * buena letra», «poquito a poco»). Sin hablante (frases citadas), se permiten esas tres cosas.
 */
export function disallowedDiminutive(text: string, speaker: string | null, trigger: ChatTrigger | null): string | null {
  const pilar = speaker === null || speaker === PILAR_ID;
  const t = pilar ? normalize(text).replace(PILAR_SET_PHRASES, " ") : normalize(text);
  const piecesGoHome = trigger === null || CAPTURE_TRIGGERS.has(trigger);
  for (const m of t.matchAll(DIMINUTIVE)) {
    const word = m[1];
    if (pilar && piecesGoHome && /^casitas?$/.test(word)) continue;
    return word;
  }
  return null;
}

/** Diminutivos (regla de estilo): ver `disallowedDiminutive`. Va la última del conjunto. */
function checkDiminutives(text: string, request: ChatWriteRequest): QualityIssue | null {
  const word = disallowedDiminutive(text, request.utterance.speaker, request.utterance.trigger);
  return word ? { reason: "expresión poco natural", term: `diminutivo ${word}` } : null;
}

// ── Expresiones descartadas (para no citarlas en el prompt) ─────────────────────────────────────────

/**
 * Expresiones artificiales que se han quitado del catálogo o que se vieron en las pruebas (sin tildes, tras
 * `normalize`). El validador ya rechaza las que puede escribir el LLM; esta lista sirve para que tampoco
 * lleguen al prompt como frase citada (ver `hasDiscardedExpression`).
 */
const DISCARDED_EXPRESSIONS = [
  "sin frenar",
  "no pienso aflojar",
  "quien me sigue",
  "esto es todo lo que teneis",
  "presion constante",
  "que tiemble el tablero",
  "captura ejecutada",
  "contratiempo tactico",
  "eficacia demostrada",
  "estoy recalculando",
  "necesitas un mapa",
  "aqui hay partido",
  "sin querer queriendo",
  "señores",
  "en directo",
];

/**
 * El texto contiene una expresión descartada: las de naturalidad (petición al dado, «golpe», «da sus
 * frutos», «no me la quites», objetivos ordinales), las de otros juegos y deportes, o las de
 * `DISCARDED_EXPRESSIONS`. `buildChatPrompt` no cita esos textos (las frases recientes que se piden no
 * repetir), para que no sirvan de modelo de estilo; el validador seguiría rechazándolos.
 */
export function hasDiscardedExpression(text: string): boolean {
  const t = normalize(text);
  return (
    DICE_REQUEST.some((re) => re.test(t)) ||
    DICE_REFLEXIVE.test(t) ||
    YOU_ARE_AT.test(t) ||
    disallowedDiminutive(text, null, null) !== null ||
    UNNATURAL.some(({ re }) => re.test(t)) ||
    KEEP_IT.test(t) ||
    ATTRIBUTION.some(({ re }) => re.test(t)) ||
    ORDINAL_GOAL.test(t) ||
    gameTerm(t) !== null ||
    GOAL_DISTANCE.some((re) => re.test(t)) ||
    OWN_RANK.test(t) ||
    DISCARDED_EXPRESSIONS.some((term) => wordsRe(term).test(t))
  );
}

// ── Conjunto ───────────────────────────────────────────────────────────────────────────────────────

/** Comprobaciones nuevas de calidad, en orden. Devuelve el primer problema o `null`. */
export function checkQuality(text: string, request: ChatWriteRequest): QualityIssue | null {
  return (
    checkLanguage(text) ??
    checkSentences(text) ??
    crossedName(text) ??
    truncatedDon(text) ??
    pilarCallsOthersAbuela(text, request.utterance.speaker) ??
    checkUsted(text, request.utterance.speaker) ??
    checkSelfThirdPerson(text, request.utterance.speaker) ??
    checkAddresseeGender(text, request) ??
    checkGameOverClaim(text, request) ??
    checkRepeatedCatchphrase(text, request) ??
    checkCountClaims(text, request) ??
    checkStreakEnd(text, request) ??
    checkGameTalk(text, request) ??
    checkRepeatedCapture(text, request) ??
    checkNaturalness(text, request) ??
    checkAttribution(text) ??
    checkBarrierTalk(text, request) ??
    checkDiminutives(text, request) ??
    // Las últimas: no cambian el diagnóstico de ninguna regla anterior.
    checkSelfAddress(text, request.utterance.speaker) ??
    checkCaptureDirection(text, request) ??
    checkCaptureTopic(text, request) ??
    checkOwnName(text, request.utterance.speaker) ??
    checkReplyEcho(text, request)
  );
}

/** Nombres que puede usar una intervención (quien habla y, si lo hay, su rival). */
export function allowedNames(request: ChatWriteRequest): ReadonlySet<string> {
  return new Set([CHARACTER_NAMES[request.utterance.speaker], request.utterance.rival ? CHARACTER_NAMES[request.utterance.rival] : ""]);
}
