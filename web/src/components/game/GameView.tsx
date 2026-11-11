import { ParchisBoard } from "@/components/board/ParchisBoard";
import { ChatPanel } from "@/components/hud/ChatPanel";
import { DicePanel } from "@/components/hud/DicePanel";
import { PlayersPanel } from "@/components/hud/PlayersPanel";
import { TurnLog, type TurnLogEntry } from "@/components/hud/TurnLog";
import { COLOR_HEX } from "@/lib/board/geometry";
import type { ChatMessage } from "@/lib/chat/schemas";
import { getAvailableMoves, type GameAction, type GameState } from "@/lib/engine";
import type { GameResponse } from "@/lib/game/api";
import { CHARACTER_NAMES } from "@/lib/game/characters";
import { describeEvent } from "@/lib/hud/events";
import type { Connection } from "@/lib/game/liveController";
import { getPlayerSummaries, getTurnInfo } from "@/lib/hud/summary";
import { cn } from "@/lib/utils";

// Se formatea en el servidor: zona horaria fija para que no dependa de dónde se ejecute.
const dateFormat = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Europe/Madrid",
});

const nameOf = (id: string) => CHARACTER_NAMES[id] ?? id;

function connectionText(connection: Connection): { text: string; tone: "ok" | "warn" | "error" } | null {
  switch (connection.kind) {
    case "connecting":
      return { text: "Conectando…", tone: "warn" };
    case "live":
      return { text: "En directo", tone: "ok" };
    case "reconnecting":
      return { text: "Reconectando con el tiempo real…", tone: "warn" };
    case "paused":
      return { text: "En pausa mientras la pestaña está oculta", tone: "warn" };
    case "retrying":
      return { text: `${connection.message} Reintentando…`, tone: "warn" };
    case "error":
      return { text: connection.message, tone: "error" };
    case "finished":
      return null;
  }
}

/** Aviso superior: partida en curso (con el turno) o terminada (ganador y clasificación). */
function GameStatusBanner({ game, connection }: { game: GameResponse; connection?: Connection }) {
  const { state } = game;

  if (game.status === "finished") {
    return (
      <section
        aria-label="Resultado"
        className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 sm:col-span-full"
      >
        <p className="text-xs font-medium tracking-widest text-amber-300 uppercase">Partida terminada</p>
        <p className="mt-1 text-2xl font-bold">
          Gana{" "}
          <span style={{ color: COLOR_HEX[state.players.find((p) => p.id === game.winner)!.color] }}>
            {nameOf(game.winner!)}
          </span>
        </p>
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300">
          {state.ranking.map((id, i) => {
            const color = state.players.find((p) => p.id === id)?.color;
            return (
              <li key={id} className="flex items-center gap-1.5">
                <span className="tabular-nums text-slate-400">{i + 1}º</span>
                {color && <span className="size-2.5 rounded-full" style={{ backgroundColor: COLOR_HEX[color] }} />}
                {nameOf(id)}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  const turnColor = state.players.find((p) => p.id === state.turn)?.color;
  const status = connection ? connectionText(connection) : null;
  return (
    <section
      aria-label="Estado"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 sm:col-span-full"
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2.5 rounded-full bg-emerald-400" />
        </span>
        En curso
      </span>
      <span className="text-sm text-slate-300">
        Turno de{" "}
        <span className="font-semibold" style={turnColor ? { color: COLOR_HEX[turnColor] } : undefined}>
          {nameOf(state.turn)}
        </span>
      </span>
      {status && (
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "ml-auto text-xs",
            status.tone === "ok" && "text-emerald-300/80",
            status.tone === "warn" && "text-amber-300",
            status.tone === "error" && "text-red-300",
          )}
        >
          {status.text}
        </span>
      )}
    </section>
  );
}

function describeAction(action: GameAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case "roll":
      return `${nameOf(action.playerId)} tira el dado`;
    case "move":
      return `${nameOf(action.playerId)} mueve la ficha ${action.pieceIndex + 1}`;
    case "timeout":
      return "Turno agotado";
  }
}

function GameInfo({ game }: { game: GameResponse }) {
  return (
    <section aria-label="Datos de la partida" className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
      <h2 className="mb-2 text-xs font-medium tracking-widest text-slate-400 uppercase">Partida</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-slate-400">Estado</dt>
        <dd>{game.status === "finished" ? "Terminada" : "En curso"}</dd>
        <dt className="text-slate-400">Versión</dt>
        <dd className="tabular-nums">{game.version}</dd>
        <dt className="text-slate-400">Actualizada</dt>
        <dd className="tabular-nums">{dateFormat.format(new Date(game.updatedAt))}</dd>
        {game.finishedAt && (
          <>
            <dt className="text-slate-400">Terminada</dt>
            <dd className="tabular-nums">{dateFormat.format(new Date(game.finishedAt))}</dd>
          </>
        )}
        <dt className="text-slate-400">ID</dt>
        <dd className="truncate font-mono text-xs leading-5 text-slate-300" title={game.id}>
          {game.id}
        </dd>
      </dl>
    </section>
  );
}

/** Datos de la partida en directo (los aporta LiveGame); sin ellos, vista estática. */
export interface LiveBoardProps {
  /** Estado a dibujar en el tablero (fotograma de la animación o el estado mostrado). */
  boardState: GameState;
  movingKey: string | null;
  transitionMs?: number;
  animating: boolean;
  /** Cambia en cada tirada para animar el dado. */
  rollKey: number;
  /** Eventos de las últimas versiones mostradas (más reciente primero). */
  log: TurnLogEntry[];
  connection: Connection;
}

/**
 * Partida en modo espectador: estado (en curso / terminada), tablero con las posiciones reales,
 * dado y turno, jugadores, jugadas y datos de la partida.
 * Solo presentación (sin hooks): sirve en el servidor (estático) y en LiveGame (en directo).
 */
export function GameView({
  game,
  live,
  chat,
}: {
  game: GameResponse;
  live?: LiveBoardProps;
  /** Mensajes del chat ya visibles (los de versiones que el tablero ha mostrado). Sin él, no hay panel. */
  chat?: readonly ChatMessage[];
}) {
  const { state } = game;
  const finished = game.status === "finished";

  // Eventos de la última acción (es lo que guarda la partida), del más reciente al más antiguo.
  const actionText = describeAction(game.lastAction);
  const log = game.lastEvents
    .map((event) => describeEvent(event, CHARACTER_NAMES))
    .filter((text): text is string => text !== null)
    .reverse()
    .map((text, i) => ({ id: i, text }));

  return (
    <div className="grid w-full max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
      <div className="lg:col-span-2">
        <GameStatusBanner game={game} connection={live?.connection} />
      </div>

      <section aria-label="Tablero" className="flex min-w-0 justify-center">
        <div
          className={cn(
            "w-full max-w-[min(100%,calc(100dvh_-_10rem))] rounded-3xl p-1 ring-1",
            finished ? "ring-amber-400/40" : "ring-emerald-400/20",
          )}
        >
          <ParchisBoard
            state={live?.boardState ?? state}
            highlightedPieces={finished || live?.animating ? [] : getAvailableMoves(state)}
            movingKey={live?.movingKey ?? null}
            transitionMs={live?.transitionMs}
          />
        </div>
      </section>

      <aside aria-label="Información de la partida" className="flex min-w-0 flex-col gap-3">
        <DicePanel turn={getTurnInfo(state)} names={CHARACTER_NAMES} rollKey={live?.rollKey ?? 0} />
        <PlayersPanel players={getPlayerSummaries(state)} names={CHARACTER_NAMES} />
        {chat && (
          <ChatPanel
            messages={chat}
            names={CHARACTER_NAMES}
            colors={Object.fromEntries(state.players.map((p) => [p.id, p.color]))}
          />
        )}
        <TurnLog
          title={live ? "Últimas jugadas" : "Última jugada"}
          description={actionText}
          emptyText="Todavía no se ha jugado ningún turno."
          entries={live?.log ?? log}
        />
        <GameInfo game={game} />
      </aside>
    </div>
  );
}
