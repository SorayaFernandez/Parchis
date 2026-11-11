import { Button } from "@/components/ui/button";
import { COLOR_HEX } from "@/lib/board/geometry";
import type { PlayerNames } from "@/lib/hud/events";
import type { TurnInfo } from "@/lib/hud/summary";
import { cn } from "@/lib/utils";
import { DiceFace } from "./DiceFace";

interface DicePanelProps {
  turn: TurnInfo;
  names: PlayerNames;
  rollKey: number;
  /** Si se pasa, se muestra el botón de lanzar (activo solo cuando se puede tirar). */
  onRoll?: () => void;
  /** Hay una animación en curso: el botón se desactiva hasta que termine. */
  busy?: boolean;
  className?: string;
}

function phaseText(turn: TurnInfo, name: string): string {
  const { phase } = turn;
  switch (phase.kind) {
    case "roll":
      return `${name} puede lanzar el dado`;
    case "move":
      return `${name} elige ficha (${phase.movablePieces.length} posible${phase.movablePieces.length === 1 ? "" : "s"})`;
    case "bonus":
      return `${name} mueve +${phase.amount} por ${phase.reason === "capture" ? "captura" : "llegar a la meta"}`;
    case "finished":
      return "Partida terminada";
  }
}

/** Panel del dado: valor, qué toca hacer en el turno, bonus y seises seguidos. */
export function DicePanel({ turn, names, rollKey, onRoll, busy = false, className }: DicePanelProps) {
  const name = names[turn.playerId] ?? turn.playerId;
  const color = COLOR_HEX[turn.color];
  const { phase } = turn;
  const diceValue = phase.kind === "move" ? phase.dice : turn.lastDice;
  const diceUsed = phase.kind !== "move";

  return (
    <section
      aria-label="Dado y turno"
      className={cn(
        "flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur",
        className,
      )}
      style={{ boxShadow: phase.kind === "finished" ? undefined : `0 0 24px -12px ${color}` }}
    >
      <DiceFace value={diceValue} rollKey={rollKey} dimmed={diceUsed} className="w-20 shrink-0 sm:w-24" />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-xs font-medium tracking-widest text-slate-400 uppercase">Turno</p>
        <p className="font-semibold leading-tight" aria-live="polite">
          <span className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ backgroundColor: color }} />
          {phaseText(turn, name)}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {phase.kind === "bonus" && (
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-bold text-amber-300 motion-safe:animate-pulse">
              Bonus +{phase.amount}
            </span>
          )}
          {phase.kind === "bonus" && phase.rollAgain && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-slate-300">Después repite tirada</span>
          )}
          {phase.kind !== "finished" && (
            <span className="flex items-center gap-1 text-slate-400" title="Seises seguidos en este turno">
              Seises
              {Array.from({ length: turn.maxSixes }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "size-2 rounded-full",
                    i < turn.sixesInTurn ? (i === turn.maxSixes - 1 ? "bg-red-400" : "bg-amber-300") : "bg-white/15",
                  )}
                />
              ))}
              <span className="sr-only">
                {turn.sixesInTurn} de {turn.maxSixes}
              </span>
            </span>
          )}
        </div>

        {onRoll && (
          <Button onClick={onRoll} disabled={!turn.canRoll || busy} className="mt-1 w-full sm:w-auto">
            {busy ? "Moviendo ficha…" : turn.canRoll ? "Lanzar dado" : "Esperando movimiento"}
          </Button>
        )}
      </div>
    </section>
  );
}
