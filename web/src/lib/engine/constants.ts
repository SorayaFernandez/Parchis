// Constantes del Parchís. Portadas de backend/game/constants.js.

import type { Color } from "./types";

/** Orden en que se asignan los colores al crear la partida. */
export const COLORS: readonly Color[] = ["pink", "purple", "green", "blue"];

/** Orden de turnos alrededor del tablero. */
export const TURN_ORDER: readonly Color[] = ["pink", "blue", "purple", "green"];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const PIECES_PER_PLAYER = 4;

/** Casillas del recorrido común (posiciones globales 0..67). */
export const MAIN_TRACK_SIZE = 68;

/** Casillas del pasillo final de cada color. */
export const FINAL_STRETCH_SIZE = 7;

/**
 * `steps` de una ficha en la meta.
 * En el pasillo `steps` va de 68 a 74, y 75 es la meta.
 */
export const FINAL_POSITION = MAIN_TRACK_SIZE + FINAL_STRETCH_SIZE;

/** `steps` de una ficha que está en casa. */
export const BASE_STEPS = -1;

/** Casilla global de salida de cada color. */
export const START_POSITIONS: Readonly<Record<Color, number>> = {
  pink: 39,
  purple: 5,
  green: 22,
  blue: 56,
};

/**
 * Última casilla global del recorrido antes de entrar al pasillo.
 * El original usaba 68 para purple y siempre lo reducía con `% 68`.
 */
export const HOME_ENTRIES: Readonly<Record<Color, number>> = {
  pink: 34,
  purple: 0,
  green: 17,
  blue: 51,
};

/**
 * Casillas seguras. El original incluía también 68, que tras `% 68`
 * es la casilla 0 (ya incluida), así que no se pierde nada.
 */
export const SAFE_CELLS: ReadonlySet<number> = new Set([
  0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63,
]);

/** Valor de dado necesario para sacar una ficha de casa. */
export const EXIT_ROLL = 5;

/** Con este valor se vuelve a tirar (y cuenta para la penalización). */
export const EXTRA_ROLL_VALUE = 6;

/** Seises seguidos que provocan la penalización. */
export const MAX_CONSECUTIVE_SIXES = 3;

/** Máximo de fichas en una casilla segura y en una normal. */
export const MAX_PIECES_SAFE_CELL = 2;
export const MAX_PIECES_NORMAL_CELL = 4;

/** Máximo de fichas en una casilla de salida tras sacar ficha. */
export const MAX_PIECES_ON_EXIT = 2;

export const CAPTURE_BONUS = 20;
export const GOAL_BONUS = 10;
