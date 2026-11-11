// Escritura del texto de cada intervención decidida por el director.
// `ChatWriter` es el punto de extensión de la fase 8.2b: un escritor con LLM implementará la misma
// interfaz (y usará `createLocalWriter` como reserva). El director y la persistencia no cambian.

import type { PlayerId } from "@/lib/engine";
import { CHARACTER_NAMES, getCharacter } from "@/lib/game/characters";
import { CHAT_LIMITS } from "./config";
import type { Random, Utterance } from "./director";
import type { ChatSource } from "./schemas";

export interface RecentText {
  speaker: PlayerId;
  text: string;
}

export interface ChatWriteRequest {
  utterance: Utterance;
  /** Textos recientes de la partida (incluidos los ya escritos en esta misma versión). */
  recent: readonly RecentText[];
  /** Texto del mensaje al que responde, si es una réplica. */
  replyToText: string | null;
  /**
   * Frases que ya ha usado este personaje en la partida (`tipo:índice`, de la más antigua a la más
   * reciente). El escritor local agota las de un tipo antes de repetir ninguna.
   */
  usedLines?: readonly string[];
  /**
   * Se aborta cuando vence el tiempo de la llamada: un escritor con red (LLM) debe pasarlo a su
   * petición HTTP para cancelarla. Su resultado tardío se ignora.
   */
  signal?: AbortSignal;
  /** Tiempo máximo de esta llamada (ms), ya ajustado a lo que queda de reserva. */
  timeoutMs?: number;
}

export interface WrittenText {
  text: string;
  source: ChatSource;
  /** Frase del catálogo usada (`tipo:índice`), para que el director la recuerde por personaje. */
  lineId?: string;
}

export interface ChatWriter {
  /** Texto de la intervención, o `null` para no decir nada. Nunca debe lanzar por un fallo esperable. */
  write(request: ChatWriteRequest): Promise<WrittenText | null>;
}

const nameOf = (id: PlayerId) => CHARACTER_NAMES[id] ?? id;

const NUMBER_WORDS = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];

/** Número en palabras para las frases ("dos", "tres"…; en cifras a partir de 11). */
export const countWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/**
 * Rellena una frase. Marcadores:
 * - `{rival}`: nombre del otro personaje.
 * - `{count}` / `{Count}`: número real de capturas de la racha, en palabras (con mayúscula inicial).
 * - `{ritmo}`: "seguidas" si lo fueron todas; si no, "en poco tiempo".
 * Devuelve `null` si a la frase le falta algún dato (no se inventa nada).
 */
export function renderLine(template: string, utterance: Pick<Utterance, "rival" | "streak">): string | null {
  let text = template;
  if (text.includes("{rival}")) {
    if (!utterance.rival) return null;
    text = text.replaceAll("{rival}", nameOf(utterance.rival));
  }
  if (/\{(count|Count|ritmo)\}/.test(text)) {
    if (!utterance.streak) return null;
    const word = countWord(utterance.streak.count);
    text = text
      .replaceAll("{Count}", word.charAt(0).toUpperCase() + word.slice(1))
      .replaceAll("{count}", word)
      .replaceAll("{ritmo}", utterance.streak.consecutive ? "seguidas" : "en poco tiempo");
  }
  return text;
}

/** Minúsculas, sin tildes ni signos, espacios simples. */
function basic(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Nombres de los personajes ya normalizados, de más largo a más corto. */
const NAMES = Object.values(CHARACTER_NAMES)
  .map(basic)
  .sort((a, b) => b.length - a.length);

/**
 * Texto normalizado para comparar: además, sin nombres de personajes (la misma frase dirigida a
 * otro rival cuenta como repetida).
 */
function normalize(text: string): string {
  let t = ` ${basic(text)} `;
  for (const name of NAMES) t = t.replaceAll(` ${name} `, " ");
  return t.replace(/\s+/g, " ").trim();
}

function trigrams(text: string): Set<string> {
  const t = ` ${normalize(text)} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

/** Similitud de Jaccard entre los trigramas de dos textos (0 = nada en común, 1 = iguales). */
export function similarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  return common / (ga.size + gb.size - common);
}

export const isRepeated = (text: string, recent: readonly RecentText[]) =>
  recent.some((r) => similarity(text, r.text) >= CHAT_LIMITS.maxSimilarity);

/**
 * Validación común para cualquier escritor (local o LLM): espacios normalizados, longitud y sin
 * repetir textos recientes. Devuelve el texto limpio o `null`.
 */
export function validateChatText(text: string, recent: readonly RecentText[]): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0 || clean.length > CHAT_LIMITS.maxTextLength) return null;
  if (/[{}<>]/.test(clean)) return null; // plantillas sin rellenar o marcado
  if (isRepeated(clean, recent)) return null;
  return clean;
}

/**
 * Escritor con las frases locales de cada personaje (sin coste ni red).
 * Entre las frases válidas (con sus datos y sin parecerse a los textos recientes de la partida),
 * elige al azar una que el personaje aún no haya usado; si ya las usó todas, la usada hace más tiempo.
 */
export function createLocalWriter(random: Random): ChatWriter {
  return {
    async write({ utterance, recent, usedLines = [] }) {
      const lines = getCharacter(utterance.speaker)?.chat.lines[utterance.kind] ?? [];
      const options = lines
        .map((line, index) => ({ id: `${utterance.kind}:${index}`, text: renderLine(line, utterance) }))
        .filter((o): o is { id: string; text: string } => o.text !== null && validateChatText(o.text, recent) === o.text);
      if (options.length === 0) return null;

      const fresh = options.filter((o) => !usedLines.includes(o.id));
      let pool = fresh;
      if (pool.length === 0) {
        const oldest = Math.min(...options.map((o) => usedLines.lastIndexOf(o.id)));
        pool = options.filter((o) => usedLines.lastIndexOf(o.id) === oldest);
      }
      const r = random();
      const index = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0;
      return { text: pool[index].text, source: "local", lineId: pool[index].id };
    },
  };
}
