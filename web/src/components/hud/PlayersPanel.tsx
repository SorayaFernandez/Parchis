import type { CSSProperties } from "react";
import Image from "next/image";
import { Progress } from "@/components/ui/progress";
import { COLOR_HEX, COLOR_LABEL, PIECE_IMAGES, PIECE_IMAGE_SCALE } from "@/lib/board/geometry";
import type { PlayerNames } from "@/lib/hud/events";
import type { PlayerSummary } from "@/lib/hud/summary";
import { cn } from "@/lib/utils";

function statusLabel(player: PlayerSummary): string {
  if (player.status === "finished") return player.place === 1 ? "Ganador" : `${player.place}º puesto`;
  if (player.status === "turn") return "En turno";
  return "Esperando";
}

function PlayerCard({ player, name, compact }: { player: PlayerSummary; name: string; compact: boolean }) {
  const color = COLOR_HEX[player.color];
  const isTurn = player.status === "turn";
  const { base, track, final, finished } = player.pieces;

  return (
    <li
      aria-current={isTurn ? "true" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-2xl border bg-white/5 p-3 transition-colors",
        compact && "xl:gap-2.5 xl:px-3 xl:py-2",
        isTurn ? "border-transparent" : "border-white/10",
        player.status === "finished" && "opacity-80",
      )}
      style={isTurn ? { borderColor: color, boxShadow: `0 0 22px -8px ${color}` } : undefined}
    >
      {/* Como el avatar del original, pero con la ficha del color (no hay avatares de usuario). */}
      <span
        className={cn("grid size-11 shrink-0 place-items-center rounded-full border-2 bg-slate-950 sm:size-12", compact && "xl:size-10")}
        style={{ borderColor: color }}
      >
        <Image
          src={PIECE_IMAGES[player.color]}
          alt=""
          width={64}
          height={64}
          className={cn("size-9", compact && "xl:size-7")}
          style={{ transform: `scale(${PIECE_IMAGE_SCALE})` }}
        />
      </span>

      <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", compact && "xl:gap-1")}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate font-semibold">
            {name}
            <span className="sr-only"> ({COLOR_LABEL[player.color]})</span>
          </p>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              isTurn ? "text-slate-950" : player.status === "finished" ? "bg-amber-400/15 text-amber-300" : "bg-white/10 text-slate-300",
            )}
            style={isTurn ? { backgroundColor: color } : undefined}
          >
            {statusLabel(player)}
          </span>
        </div>

        <Progress
          value={player.progress}
          aria-label={`Progreso de ${name}`}
          className="[&_[data-slot=progress-indicator]]:bg-(--player) [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-white/10"
          style={{ "--player": color } as CSSProperties}
        />

        <p className="flex flex-wrap gap-x-2 text-[11px] text-slate-400 tabular-nums">
          <span title="Fichas en casa">Casa {base}</span>
          <span title="Fichas en el recorrido">Recorrido {track}</span>
          <span title="Fichas en el pasillo final">Pasillo {final}</span>
          <span title="Fichas en la meta">Meta {finished}</span>
        </p>
      </div>
    </li>
  );
}

interface PlayersPanelProps {
  players: PlayerSummary[];
  names: PlayerNames;
  /** Tarjetas más compactas desde `xl` (pantalla de partida en tres columnas). Por defecto, sin cambios. */
  compact?: boolean;
  className?: string;
}

/** Los jugadores con su color, estado de partida y progreso; resalta al que tiene el turno. */
export function PlayersPanel({ players, names, compact = false, className }: PlayersPanelProps) {
  return (
    <section aria-label="Jugadores" className={cn(compact && "xl:shrink-0", className)}>
      <ul className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-1", compact && "xl:gap-1.5")}>
        {players.map((player) => (
          <PlayerCard key={player.id} player={player} name={names[player.id] ?? player.id} compact={compact} />
        ))}
      </ul>
    </section>
  );
}
