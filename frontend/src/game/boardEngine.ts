export type Point = { x: number; y: number };

export const BOARD_SIZE = 600;

export const mainTrack: Point[] = [];

export const CENTER: Point = {
  x: 300,
  y: 300,
};

export const bases: Record<string, Point[]> = {
  pink: [
    { x: 480, y: 100 },
    { x: 520, y: 100 },
    { x: 480, y: 140 },
    { x: 520, y: 140 },
  ],
  blue: [
    { x: 480, y: 80 },
    { x: 520, y: 80 },
    { x: 480, y: 120 },
    { x: 520, y: 120 },
  ],
  green: [
    { x: 80, y: 480 },
    { x: 120, y: 480 },
    { x: 80, y: 520 },
    { x: 120, y: 520 },
  ],
  purple: [
    { x: 480, y: 480 },
    { x: 520, y: 480 },
    { x: 480, y: 520 },
    { x: 520, y: 520 },
  ],
};