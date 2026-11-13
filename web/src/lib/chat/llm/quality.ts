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

function checkUsted(text: string, speaker: string): QualityIssue | null {
  if (speaker !== USTED_SPEAKER) return null;
  // Con tildes: «estás» es tuteo, pero «estas» (demostrativo) no.
  const t = withoutQuotes(text).toLowerCase();
  for (const word of TUTEO) {
    if (wordsRe(word).test(t)) return { reason: "tutea (Don Ernesto)", term: word };
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
 * Metáforas deportivas de comentarista («¡Golazo por la escuadra!»): solo las puede usar Chispa, cuya
 * forma de hablar es la de un comentarista (sus frases locales ya las usan). Para el resto, prohibidas.
 */
export const SPORTS_METAPHORS = ["gol", "golazo", "por la escuadra", "triple", "canasta", "futbol", "baloncesto", "tenis"];
/** Chispa: su forma de hablar es la de un comentarista (ver `characters.ts`). */
export const COMMENTATOR = "ai-blue";

const STREAK_TRIGGERS: ReadonlySet<ChatTrigger> = new Set(["capture_streak", "bad_streak"]);

/** Afirmaciones sobre la marcha de la partida que la intervención no respalda. */
const STATE_CLAIMS: readonly RegExp[] = [
  // Eliminación (en el parchís nadie queda «fuera»).
  /(?<![\p{L}])(?:estas|esta|estais|estan|quedas|queda|quedais)\s+(?:ya\s+)?(?:casi\s+)?(?:fuera|eliminad[oa]s?)(?![\p{L}])/u,
  /(?<![\p{L}])(?:casi\s+fuera|fuera\s+de\s+la\s+partida|eliminad[oa]s?)(?![\p{L}])/u,
  // Posición en la partida («voy ganando», «vas el último», «eres el último»), pero no «es la primera
  // vez» ni «va la primera ficha».
  /(?<![\p{L}])(?:vas|va|voy|vais|van|vamos)\s+(?:el\s+|la\s+)?(?:ultim[oa]|primer[oa]|ganando|perdiendo|en\s+cabeza|por\s+delante|por\s+detras|a\s+la\s+cola)(?![\p{L}])(?!\s+(?:vez|ficha|fichas|casilla|tirada|en\s+\p{L}+))/u,
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
const STREAK_CLAIM = /(?<![\p{L}])(?:racha|rachas|seguidas|seguidos|consecutivas|consecutivos)(?![\p{L}])/u;

function checkGameTalk(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  for (const term of OTHER_GAMES) if (wordsRe(term).test(t)) return { reason: "expresión ajena al parchís", term };
  if (request.utterance.speaker !== COMMENTATOR) {
    for (const term of SPORTS_METAPHORS) if (wordsRe(term).test(t)) return { reason: "expresión ajena al parchís", term };
  }
  const streak = STREAK_CLAIM.exec(t);
  if (streak && !hasStreakContext(request)) return { reason: "afirmación no respaldada", term: streak[0] };
  for (const re of STATE_CLAIMS) {
    const match = re.exec(t);
    if (match) return { reason: "afirmación no respaldada", term: match[0].replace(/\s+/g, " ") };
  }
  const result = RESULT_CLAIM.exec(t);
  if (result && request.utterance.trigger !== "victory") return { reason: "afirmación no respaldada", term: result[0].replace(/\s+/g, " ") };
  return null;
}

// ── Hablar de sí mismo en tercera persona ──────────────────────────────────────────────────────────

/**
 * Nombres y alias con los que un personaje podría nombrarse a sí mismo. «la abuela» no está para Pilar:
 * hablar de sí misma como «la abuela» es parte de su personaje (sus frases locales lo usan: «La abuela
 * también sabe», «a la abuela se la respeta»).
 */
const SELF_NAMES: Readonly<Record<string, readonly string[]>> = {
  "ai-pink": ["brava"],
  "ai-purple": ["don ernesto", "ernesto"],
  "ai-green": ["abuela pilar", "pilar"],
  "ai-blue": ["chispa"],
};
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
 * Se permite su nombre en otras construcciones («¡Gol de Chispa!», «Soy Brava») y nombrar a los rivales.
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
    checkRepeatedCatchphrase(text, request) ??
    checkCountClaims(text, request) ??
    checkStreakEnd(text, request) ??
    checkGameTalk(text, request)
  );
}

/** Nombres que puede usar una intervención (quien habla y, si lo hay, su rival). */
export function allowedNames(request: ChatWriteRequest): ReadonlySet<string> {
  return new Set([CHARACTER_NAMES[request.utterance.speaker], request.utterance.rival ? CHARACTER_NAMES[request.utterance.rival] : ""]);
}
