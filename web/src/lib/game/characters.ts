// Catálogo de personajes IA. El `id` es estable: se guarda en el GameState (`players[].id`)
// y no debe cambiar nunca. El nombre visible (y en el futuro la personalidad) puede cambiar
// sin afectar a las partidas guardadas.

import { COLORS, type Color, type PlayerId } from "@/lib/engine";

export interface Character {
  id: PlayerId;
  /** Nombre visible (provisional hasta definir las personalidades en la fase de IA). */
  name: string;
  /** Color que le asigna `createGame()` por su posición en el catálogo. */
  color: Color;
}

/**
 * Los cuatro personajes, en el orden en que `createGame()` asigna los colores (COLORS:
 * pink, purple, green, blue). No reordenar: cambiaría el color de cada personaje.
 */
export const CHARACTERS: readonly Character[] = [
  { id: "ai-pink", name: "Rosa", color: "pink" },
  { id: "ai-purple", name: "Morado", color: "purple" },
  { id: "ai-green", name: "Verde", color: "green" },
  { id: "ai-blue", name: "Azul", color: "blue" },
];

export const CHARACTER_IDS: readonly PlayerId[] = CHARACTERS.map((c) => c.id);

export const CHARACTER_NAMES: Readonly<Record<PlayerId, string>> = Object.fromEntries(
  CHARACTERS.map((c) => [c.id, c.name]),
);

// Comprobación al cargar el módulo: el catálogo debe seguir el orden de colores del motor.
if (CHARACTERS.some((c, i) => c.color !== COLORS[i])) {
  throw new Error("CHARACTERS debe seguir el orden de COLORS del motor");
}
