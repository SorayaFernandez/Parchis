import { BOARD_SIZE } from "@/lib/board/geometry";

/**
 * Capas gráficas del tablero original (frontend/public/board/), en el mismo orden y
 * con la misma opacidad que frontend/src/game/board/GameBoard.tsx. Todas son cuadradas,
 * así que se superponen sobre el mismo viewBox.
 */
const LAYERS = [
  { href: "/board/board-base.svg", opacity: 1 },
  { href: "/board/board-path.svg", opacity: 0.9 },
  { href: "/board/board-glow.svg", opacity: 0.9, blend: "screen" },
  { href: "/board/board-effects.svg", opacity: 0.9, blend: "screen" },
  { href: "/board/board-home-paths.svg", opacity: 0.5 },
] as const;

export function BoardLayers() {
  return (
    <g aria-hidden="true" pointerEvents="none">
      {LAYERS.map((layer) => (
        <image
          key={layer.href}
          href={layer.href}
          width={BOARD_SIZE}
          height={BOARD_SIZE}
          opacity={layer.opacity}
          style={"blend" in layer ? { mixBlendMode: layer.blend } : undefined}
        />
      ))}
    </g>
  );
}
