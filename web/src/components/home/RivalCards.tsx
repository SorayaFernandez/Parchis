import type { CSSProperties } from "react";
import Image from "next/image";
import { COLOR_HEX, PIECE_IMAGES, PIECE_IMAGE_SCALE } from "@/lib/board/geometry";
import type { PlayerId } from "@/lib/engine";
import { CHARACTERS } from "@/lib/game/characters";
import { inDisplayOrder } from "@/lib/hud/displayOrder";

/**
 * Presentación de cada personaje en la portada. El carácter es el de su perfil; la forma de jugar
 * resume su estrategia real (`strategy` en characters.ts: multiplicadores de captura, barrera, casilla
 * segura y avance); la frase es una de sus expresiones del catálogo (`catchphrases`).
 */
const RIVALS: Readonly<Record<PlayerId, { tagline: string; plays: string; quote: number }>> = {
  "ai-pink": { tagline: "Agresiva y competitiva", plays: "Va a por tus fichas: caza y captura siempre que puede.", quote: 0 },
  "ai-purple": { tagline: "Estratega y calculador", plays: "Levanta barreras y mide cada riesgo antes de mover.", quote: 1 },
  "ai-green": { tagline: "Prudente y entrañable", plays: "Busca las casillas seguras y no arriesga sin motivo.", quote: 0 },
  "ai-blue": { tagline: "Imprevisible y divertido", plays: "Corre sin mirar atrás y, de vez en cuando, sorprende.", quote: 2 },
};

/** Los cuatro personajes, en el mismo orden visual que en la partida (Chispa, Don Ernesto, Abuela Pilar, Brava). */
export function RivalCards() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {inDisplayOrder(CHARACTERS).map((character) => {
        const color = COLOR_HEX[character.color];
        const rival = RIVALS[character.id];
        return (
          <li
            key={character.id}
            className="group relative flex flex-col gap-4 overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60 p-6 backdrop-blur transition-colors hover:border-(--rival)/60"
            style={{ "--rival": color } as CSSProperties}
          >
            {/* Halo del color del personaje. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full opacity-25 blur-3xl transition-opacity group-hover:opacity-40"
              style={{ backgroundColor: color }}
            />
            <div className="flex items-center gap-4">
              <span
                className="grid size-16 shrink-0 place-items-center rounded-full border-2 bg-slate-950"
                style={{ borderColor: color, boxShadow: `0 0 28px -6px ${color}` }}
              >
                <Image src={PIECE_IMAGES[character.color]} alt="" width={96} height={96} className="size-12" style={{ transform: `scale(${PIECE_IMAGE_SCALE})` }} />
              </span>
              <div className="min-w-0">
                <h3 className="text-xl font-bold" style={{ color }}>
                  {character.name}
                </h3>
                <p className="text-sm text-slate-300">{rival.tagline}</p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-slate-400">{rival.plays}</p>
            <blockquote className="mt-auto rounded-2xl border-l-2 bg-black/30 px-4 py-3 text-sm text-slate-100" style={{ borderLeftColor: color }}>
              «{character.catchphrases[rival.quote]}»
            </blockquote>
          </li>
        );
      })}
    </ul>
  );
}
