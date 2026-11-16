// Detección de las coletillas (expresiones características) de cada personaje, compartida por el
// director (registro de las publicadas), el escritor local (preferencia) y el validador del LLM.
// Pura y sin estado: el registro de cada partida vive en `DirectorState.usedCatchphrases`.

import type { PlayerId } from "@/lib/engine";
import { CHARACTERS } from "@/lib/game/characters";

/** Minúsculas y sin tildes (la «ñ» se conserva). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/(?!̃)[̀-ͯ]/g, "")
    .normalize("NFC");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * La coletilla al inicio de una frase (tras el inicio o un signo), siga o no con más palabras:
 * «¡A casa!», «¡A casa, Chispa!» y «¡A casa con eso!» son la misma expresión; «Vuelve a casa», no.
 * Se aplica sobre texto normalizado.
 */
export function catchphraseRe(phrase: string): RegExp {
  // Entre palabras, cualquier separador que no sea letra ni cifra: «Ay, hijo, qué prisas» lleva comas.
  const words = normalizeText(phrase).replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).map(escape).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(?:^|[¡!¿?.,;:…—«»"“”-])\\s*${words}(?![\\p{L}\\p{N}])`, "u");
}

/** Patrones de cada personaje, calculados una vez al cargar a partir del catálogo (inmutable). */
const PATTERNS: ReadonlyMap<PlayerId, readonly RegExp[]> = new Map(CHARACTERS.map((c) => [c.id, c.catchphrases.map(catchphraseRe)]));
const patternsOf = (speaker: PlayerId): readonly RegExp[] => PATTERNS.get(speaker) ?? [];

/**
 * Índices (en `character.catchphrases`) de las coletillas de `speaker` que aparecen en `text`. Solo
 * las de ese personaje: las palabras comunes o las coletillas de otros no cuentan.
 */
export function detectCatchphrases(speaker: PlayerId, text: string): number[] {
  const t = normalizeText(text);
  const found: number[] = [];
  patternsOf(speaker).forEach((re, index) => {
    if (re.test(t)) found.push(index);
  });
  return found;
}

/** Añade al registro las coletillas detectadas (sin duplicados, en orden), acotado a `max`. */
export function addCatchphrases(used: readonly number[], detected: readonly number[], max: number): number[] {
  const next = [...used];
  for (const index of detected) if (!next.includes(index)) next.push(index);
  return next.slice(-max);
}
