// Respuesta del selector estratégico (puro). Solo se acepta exactamente un objeto JSON
// `{"choice":"<id>"}` con uno de los identificadores de la decisión. No se repara nada ni se adivina:
// cualquier otra cosa se rechaza con un motivo fijo, y quien llama usará la estrategia local.

import { z } from "zod";
import type { MoveDecision, MoveOptionId } from "./options";

/** Motivos de rechazo (textos fijos, sin el contenido del modelo). */
export const MOVE_PARSE_REASONS = [
  "respuesta truncada",
  "respuesta sin texto",
  "no es solo un objeto JSON",
  "JSON inválido",
  "clave duplicada",
  "formato no válido",
  "opción inexistente",
] as const;
export type MoveParseReason = (typeof MOVE_PARSE_REASONS)[number];

export type MoveParseResult =
  | { ok: true; id: MoveOptionId; pieceIndex: number }
  | { ok: false; reason: MoveParseReason };

const ChoiceSchema = z.strictObject({ choice: z.string() });

/**
 * Claves del objeto exterior tal como aparecen en el texto (ya decodificadas: `"\u0063hoice"` es
 * `choice`). `JSON.parse` se queda con el último valor de una clave repetida sin avisar, así que la
 * repetición solo se ve en el texto. Recorre el JSON (ya validado con `JSON.parse`) respetando las
 * cadenas y sus escapes, y solo toma como clave la cadena que abre cada par del nivel 1.
 */
export function topLevelKeys(json: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      // Fin de la cadena: la siguiente comilla que no esté escapada.
      let j = i + 1;
      while (json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(json.slice(i, j + 1)) as string);
        expectKey = false;
      }
      i = j;
    } else if (c === "{" || c === "[") {
      depth++;
      if (c === "{" && depth === 1) expectKey = true;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

/**
 * Valida la respuesta del modelo contra la decisión que se le envió.
 * - `finishReason: "length"` → truncada (aunque el texto parezca válido).
 * - `content` debe ser texto que, sin los espacios de los extremos, sea un único objeto JSON: nada de
 *   texto alrededor ni bloques Markdown.
 * - Sin claves repetidas en el texto (aunque `JSON.parse` las acepte).
 * - Objeto estricto con solo `choice` (texto), y que sea exactamente uno de los identificadores enviados
 *   (sin cambiar mayúsculas ni recortar).
 */
export function parseMoveChoice(response: { content: unknown; finishReason?: unknown }, decision: MoveDecision): MoveParseResult {
  if (response.finishReason === "length") return { ok: false, reason: "respuesta truncada" };
  if (typeof response.content !== "string" || response.content.trim() === "") return { ok: false, reason: "respuesta sin texto" };

  const text = response.content.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, reason: "no es solo un objeto JSON" };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSON inválido" };
  }

  // Una clave repetida (con el mismo valor o con otro) se rechaza: no se elige ninguno de los valores.
  const keys = topLevelKeys(text);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "clave duplicada" };

  const parsed = ChoiceSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "formato no válido" };

  const option = decision.options.find((o) => o.id === parsed.data.choice);
  if (!option) return { ok: false, reason: "opción inexistente" };
  return { ok: true, id: option.id, pieceIndex: option.pieceIndex };
}
