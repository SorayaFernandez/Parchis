// Orden en que se MUESTRAN los jugadores en la pantalla de partida. Solo presentación: el orden
// interno (`state.players`) y el de los turnos (`TURN_ORDER`) del motor no cambian.

import type { Color } from "@/lib/engine";

/** Chispa (azul), Don Ernesto (morado), Abuela Pilar (verde) y Brava (rosa). */
export const PLAYER_DISPLAY_ORDER: readonly Color[] = ["blue", "purple", "green", "pink"];

/** Copia de `items` en el orden de `PLAYER_DISPLAY_ORDER` (sin modificar el original). */
export function inDisplayOrder<T extends { color: Color }>(items: readonly T[]): T[] {
  const rank = (item: T) => PLAYER_DISPLAY_ORDER.indexOf(item.color);
  return [...items].sort((a, b) => rank(a) - rank(b));
}
