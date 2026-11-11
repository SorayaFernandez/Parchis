// Convierte el estado del motor en posiciones de dibujo para cada ficha.
// La posición lógica se obtiene con las funciones y constantes del motor; aquí no hay reglas.

import {
  FINAL_POSITION,
  MAIN_TRACK_SIZE,
  getRealBoardPosition,
  type Color,
  type GameState,
  type PlayerId,
} from "@/lib/engine";
import {
  BASE_SLOTS,
  CELL_LENGTH,
  GOAL_SLOTS,
  HOME_STRETCH,
  TRACK_CELLS,
  isStretchVertical,
  isTrackCellInVerticalArm,
  type Point,
} from "./geometry";
import { pieceKey } from "./animation";

export type BoardSlot =
  | { kind: "base"; color: Color; pieceIndex: number }
  | { kind: "goal"; color: Color; pieceIndex: number }
  | { kind: "track"; cell: number }
  | { kind: "stretch"; color: Color; index: number };

/** Dónde está una ficha según sus `steps` (mismo convenio que el motor). */
export function getPieceSlot(color: Color, pieceIndex: number, steps: number): BoardSlot {
  if (steps < 0) return { kind: "base", color, pieceIndex };
  if (steps >= FINAL_POSITION) return { kind: "goal", color, pieceIndex };
  if (steps >= MAIN_TRACK_SIZE) return { kind: "stretch", color, index: steps - MAIN_TRACK_SIZE };
  return { kind: "track", cell: getRealBoardPosition(color, steps) };
}

function slotKey(slot: BoardSlot): string {
  switch (slot.kind) {
    case "track":
      return `track:${slot.cell}`;
    case "stretch":
      return `stretch:${slot.color}:${slot.index}`;
    default:
      return `${slot.kind}:${slot.color}:${slot.pieceIndex}`;
  }
}

function slotCenter(slot: BoardSlot): Point {
  switch (slot.kind) {
    case "track":
      return TRACK_CELLS[slot.cell];
    case "stretch":
      return HOME_STRETCH[slot.color][slot.index];
    case "base":
      return BASE_SLOTS[slot.color][slot.pieceIndex];
    case "goal":
      return GOAL_SLOTS[slot.color][slot.pieceIndex];
  }
}

function spreadHorizontally(slot: BoardSlot): boolean {
  if (slot.kind === "track") return isTrackCellInVerticalArm(slot.cell);
  if (slot.kind === "stretch") return isStretchVertical(slot.color);
  return true;
}

/**
 * Diámetro visible de la ficha según cuántas comparten casilla. Una sola ficha cabe en
 * el eje corto de la casilla (≈79) y en los círculos de casa (≈70). Con varias, se
 * reparten a lo largo del eje largo (≈109) sin salirse.
 */
const PIECE_SIZE_BY_COUNT = [58, 58, 50, 36, 27];
export const PIECE_SIZE = PIECE_SIZE_BY_COUNT[1];

export interface PieceLayout {
  /** Clave estable para React y para animar el desplazamiento. */
  key: string;
  playerId: PlayerId;
  color: Color;
  pieceIndex: number;
  steps: number;
  slot: BoardSlot;
  x: number;
  y: number;
  /** Diámetro visible de la ficha (sin el margen transparente del PNG). */
  size: number;
  /** Fichas en la misma casilla (incluida esta). */
  stackSize: number;
}

export interface LayoutOptions {
  /**
   * Ficha en movimiento durante una animación: no se apila con las que encuentra en
   * el camino (que así no se recolocan a cada paso) y se dibuja centrada en la casilla.
   */
  movingKey?: string | null;
}

/**
 * Posiciones de las 16 fichas (o las que haya). Agrupa por casilla lógica en una
 * sola pasada, así una ficha nunca se dibuja dos veces. Si hay varias, las reparte
 * a lo largo del eje largo de la casilla.
 */
export function layoutPieces(state: GameState, { movingKey = null }: LayoutOptions = {}): PieceLayout[] {
  const groups = new Map<string, Omit<PieceLayout, "x" | "y" | "size" | "stackSize">[]>();
  let moving: PieceLayout | null = null;

  for (const player of state.players) {
    player.pieces.forEach((piece, pieceIndex) => {
      const slot = getPieceSlot(player.color, pieceIndex, piece.steps);
      const entry = {
        key: pieceKey(player.id, pieceIndex),
        playerId: player.id,
        color: player.color,
        pieceIndex,
        steps: piece.steps,
        slot,
      };
      if (entry.key === movingKey) {
        moving = { ...entry, ...slotCenter(slot), size: PIECE_SIZE, stackSize: 1 };
        return;
      }
      const key = slotKey(slot);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    });
  }

  const result: PieceLayout[] = [];
  for (const group of groups.values()) {
    const n = group.length;
    const size = PIECE_SIZE_BY_COUNT[Math.min(n, PIECE_SIZE_BY_COUNT.length - 1)];
    const spacing = n > 1 ? Math.min(size, CELL_LENGTH / n) : 0;
    const center = slotCenter(group[0].slot);
    const horizontal = spreadHorizontally(group[0].slot);

    group.forEach((piece, i) => {
      const offset = (i - (n - 1) / 2) * spacing;
      result.push({
        ...piece,
        x: center.x + (horizontal ? offset : 0),
        y: center.y + (horizontal ? 0 : offset),
        size,
        stackSize: n,
      });
    });
  }

  if (moving) result.push(moving);
  // Orden siempre estable (jugador y ficha): si React reordenara los nodos, el navegador
  // podría cortar la transición de `transform` de la ficha que se mueve.
  return result.sort((a, b) => a.key.localeCompare(b.key));
}
