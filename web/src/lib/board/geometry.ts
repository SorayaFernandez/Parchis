// Geometría del tablero en el sistema de coordenadas del SVG (viewBox 0 0 1600 1600).
// Sin reglas de juego: solo dónde se dibuja cada casilla.

import type { Color } from "@/lib/engine";

export interface Point {
  x: number;
  y: number;
}

export const BOARD_SIZE = 1600;

/** `board-path.svg` está dibujado en 732×732. */
const PATH_SCALE = BOARD_SIZE / 732;
/** `board-base.svg` y el resto de capas están dibujadas en 1000×1000. */
const BASE_SCALE = BOARD_SIZE / 1000;

const scalePath = (x: number, y: number): Point => ({ x: x * PATH_SCALE, y: y * PATH_SCALE });
const scaleBase = (x: number, y: number): Point => ({ x: x * BASE_SCALE, y: y * BASE_SCALE });

/**
 * Centro de cada casilla global del recorrido (índice = casilla 0..67).
 * Portado de backend/game/utils/boardMap.js; verificado sobre board-path.svg.
 */
const TRACK_732: ReadonlyArray<readonly [number, number]> = [
  [366, 711], // 0 (impresa como 68)
  [416, 711], [416, 675], [416, 639], [416, 603], [416, 567], [416, 531], [416, 495], [416, 459], // 1-8
  [459, 416], [495, 416], [531, 416], [567, 416], [603, 416], [639, 416], [675, 416], [711, 416], // 9-16
  [711, 366], // 17
  [711, 316], [675, 316], [639, 316], [603, 316], [567, 316], [531, 316], [495, 316], [459, 316], // 18-25
  [416, 273], [416, 237], [416, 201], [416, 165], [416, 129], [416, 93], [416, 57], [416, 21], // 26-33
  [366, 21], // 34
  [315, 21], [315, 57], [315, 93], [315, 129], [315, 165], [315, 201], [315, 237], [315, 273], // 35-42
  [273, 316], [237, 316], [201, 316], [165, 316], [129, 316], [93, 316], [57, 316], [21, 316], // 43-50
  [21, 366], // 51
  [21, 416], [57, 416], [93, 416], [129, 416], [165, 416], [201, 416], [237, 416], [273, 416], // 52-59
  [315, 459], [315, 495], [315, 531], [315, 567], [315, 603], [315, 639], [315, 675], [315, 711], // 60-67
];

export const TRACK_CELLS: readonly Point[] = TRACK_732.map(([x, y]) => scalePath(x, y));

/**
 * Centros de las 7 casillas del pasillo final de cada color, desde la entrada hacia el centro.
 * Portado de backend/game/utils/homeStretchMap.js. Corrección: en el original blue y
 * green estaban desplazados una casilla hacia el centro. Ahora coinciden con los
 * rectángulos de board-path.svg.
 */
const STRETCH_732: Record<Color, readonly number[]> = {
  pink: [57, 93, 129, 165, 201, 237, 273], // y, columna x = 366
  purple: [675, 639, 603, 567, 531, 495, 459], // y, columna x = 366
  blue: [57, 93, 129, 165, 201, 237, 273], // x, fila y = 366
  green: [675, 639, 603, 567, 531, 495, 459], // x, fila y = 366
};

export const HOME_STRETCH: Readonly<Record<Color, readonly Point[]>> = {
  pink: STRETCH_732.pink.map((y) => scalePath(366, y)),
  purple: STRETCH_732.purple.map((y) => scalePath(366, y)),
  blue: STRETCH_732.blue.map((x) => scalePath(x, 366)),
  green: STRETCH_732.green.map((x) => scalePath(x, 366)),
};

/** Círculos de las casas en board-base.svg (uno por ficha). */
const baseSlots = (cx: number, cy: number): Point[] =>
  [
    [cx, cy],
    [cx + 90, cy],
    [cx, cy + 90],
    [cx + 90, cy + 90],
  ].map(([x, y]) => scaleBase(x, y));

export const BASE_SLOTS: Readonly<Record<Color, readonly Point[]>> = {
  pink: baseSlots(155, 155),
  green: baseSlots(755, 155),
  blue: baseSlots(155, 755),
  purple: baseSlots(755, 755),
};

/**
 * Posiciones en la meta (triángulos centrales).
 * Portado de finishedPositions en frontend/src/game/boardPositions.ts.
 */
export const GOAL_SLOTS: Readonly<Record<Color, readonly Point[]>> = {
  pink: [{ x: 730, y: 670 }, { x: 870, y: 670 }, { x: 800, y: 670 }, { x: 800, y: 740 }],
  green: [{ x: 920, y: 730 }, { x: 920, y: 870 }, { x: 920, y: 800 }, { x: 850, y: 800 }],
  blue: [{ x: 680, y: 730 }, { x: 680, y: 870 }, { x: 680, y: 800 }, { x: 750, y: 800 }],
  purple: [{ x: 730, y: 925 }, { x: 870, y: 925 }, { x: 800, y: 925 }, { x: 800, y: 855 }],
};

/**
 * Las casillas de los brazos verticales (arriba y abajo) son más anchas que altas,
 * así que las fichas apiladas se reparten en horizontal; en los brazos horizontales,
 * en vertical. Para el pasillo final, se usa el eje de cada color.
 */
export function isTrackCellInVerticalArm(cell: number): boolean {
  const [, y] = TRACK_732[cell];
  return y < 300 || y > 432;
}

export function isStretchVertical(color: Color): boolean {
  return color === "pink" || color === "purple";
}

/** Eje largo de una casilla (50 unidades en board-path.svg). */
export const CELL_LENGTH = 50 * PATH_SCALE;

/** Eje corto de una casilla (36 unidades en board-path.svg). */
export const CELL_WIDTH = 36 * PATH_SCALE;

/**
 * Los PNG de las fichas (512×512) tienen margen transparente: la ficha visible
 * ocupa 343 px centrados. Para que una ficha se vea de diámetro `d`, la imagen se
 * dibuja a `d * PIECE_IMAGE_SCALE`.
 */
export const PIECE_IMAGE_SCALE = 512 / 343;

/** Imágenes de las fichas (copiadas de frontend/public/pieces/). */
export const PIECE_IMAGES: Readonly<Record<Color, string>> = {
  pink: "/pieces/pink-piece.png",
  purple: "/pieces/purple-piece.png",
  green: "/pieces/green-piece.png",
  blue: "/pieces/blue-piece.png",
};

export const COLOR_HEX: Readonly<Record<Color, string>> = {
  pink: "#ff3bd4",
  purple: "#c86cff",
  green: "#00ff9d",
  blue: "#00d9ff",
};

export const COLOR_LABEL: Readonly<Record<Color, string>> = {
  pink: "rosa",
  purple: "morado",
  green: "verde",
  blue: "azul",
};
