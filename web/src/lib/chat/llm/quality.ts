// Comprobaciones de calidad de los textos del LLM (puras, sin red). Las usa `cleanLlmText` después de
// las comprobaciones de formato, longitud y nombres; si alguna falla, el texto se rechaza y el servicio
// publica la frase local. Devuelven el motivo (texto fijo) y el término de NUESTRO catálogo que ha
// coincidido, para el diagnóstico: nunca el texto del modelo.
//
// Origen: problemas vistos en Preview (partida 707c3c6d…): frase en inglés, «la abuela Brava», «racha»
// en una captura simple, Don Ernesto tuteando, coletillas copiadas, «tres en raya» y «ya casi estás fuera».

import { getCharacter, CHARACTER_NAMES } from "@/lib/game/characters";
import type { ChatTrigger } from "../schemas";
import type { ChatWriteRequest } from "../writer";

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
] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];

/** Minúsculas y sin tildes (la «ñ» se conserva). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/(?!̃)[̀-ͯ]/g, "")
    .normalize("NFC");
}

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
const ALIASES: Readonly<Record<string, readonly string[]>> = {
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

/** La coletilla como frase propia: entre el inicio o un signo y el final o un signo («¡A casa, …!»). */
const clauseRe = (phrase: string) => {
  const words = normalize(phrase).replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).map(escape).join("\\s+");
  return new RegExp(`(?:^|[¡!¿?.,;:…—«»"“”-])\\s*${words}\\s*(?=$|[¡!¿?.,;:…—«»"“”-])`, "u");
};

function checkRepeatedCatchphrase(text: string, request: ChatWriteRequest): QualityIssue | null {
  const character = getCharacter(request.utterance.speaker);
  if (!character) return null;
  const own = request.recent.filter((r) => r.speaker === request.utterance.speaker).map((r) => normalize(r.text));
  if (own.length === 0) return null;
  const t = normalize(text);
  for (const phrase of character.catchphrases) {
    const re = clauseRe(phrase);
    if (re.test(t) && own.some((previous) => re.test(previous))) return { reason: "expresión característica repetida", term: phrase };
  }
  return null;
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
/** Hablar de rachas o de capturas seguidas: solo en las intervenciones de racha. */
const STREAK_CLAIM = /(?<![\p{L}])(?:racha|rachas|seguidas|seguidos)(?![\p{L}])/u;

function checkGameTalk(text: string, request: ChatWriteRequest): QualityIssue | null {
  const t = normalize(text);
  for (const term of OTHER_GAMES) if (wordsRe(term).test(t)) return { reason: "expresión ajena al parchís", term };
  if (request.utterance.speaker !== COMMENTATOR) {
    for (const term of SPORTS_METAPHORS) if (wordsRe(term).test(t)) return { reason: "expresión ajena al parchís", term };
  }
  const streak = STREAK_CLAIM.exec(t);
  if (streak && !STREAK_TRIGGERS.has(request.utterance.trigger)) return { reason: "afirmación no respaldada", term: streak[0] };
  for (const re of STATE_CLAIMS) {
    const match = re.exec(t);
    if (match) return { reason: "afirmación no respaldada", term: match[0].replace(/\s+/g, " ") };
  }
  const result = RESULT_CLAIM.exec(t);
  if (result && request.utterance.trigger !== "victory") return { reason: "afirmación no respaldada", term: result[0].replace(/\s+/g, " ") };
  return null;
}

// ── Conjunto ───────────────────────────────────────────────────────────────────────────────────────

/** Comprobaciones nuevas de calidad, en orden. Devuelve el primer problema o `null`. */
export function checkQuality(text: string, request: ChatWriteRequest): QualityIssue | null {
  return (
    checkLanguage(text) ??
    crossedName(text) ??
    checkUsted(text, request.utterance.speaker) ??
    checkRepeatedCatchphrase(text, request) ??
    checkGameTalk(text, request)
  );
}

/** Nombres que puede usar una intervención (quien habla y, si lo hay, su rival). */
export function allowedNames(request: ChatWriteRequest): ReadonlySet<string> {
  return new Set([CHARACTER_NAMES[request.utterance.speaker], request.utterance.rival ? CHARACTER_NAMES[request.utterance.rival] : ""]);
}
