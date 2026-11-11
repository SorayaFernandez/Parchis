"use client";

import { useCallback, useEffect, useState } from "react";
import { DicePanel } from "@/components/hud/DicePanel";
import { PlayersPanel } from "@/components/hud/PlayersPanel";
import { TurnLog, type TurnLogEntry } from "@/components/hud/TurnLog";
import { Button } from "@/components/ui/button";
import { applyPositions, buildAnimation } from "@/lib/board/animation";
import { DEMO_PLAYER_NAMES, createDemoGame, createShowcaseState } from "@/lib/board/demo";
import { applyAction, getAvailableMoves, type GameAction, type GameState } from "@/lib/engine";
import { describeEvent } from "@/lib/hud/events";
import { getPlayerSummaries, getTurnInfo } from "@/lib/hud/summary";
import { ParchisBoard } from "./ParchisBoard";
import { useBoardAnimation } from "./useBoardAnimation";

const LOG_SIZE = 6;
/** Pausa entre acciones en modo automático (después de que termine la animación). */
const AUTO_PAUSE_MS = 450;

interface DemoState {
  /** Estado real del motor. El tablero puede estar mostrando aún un fotograma anterior. */
  game: GameState;
  log: TurnLogEntry[];
  /** Número de tiradas: reinicia la animación del dado. */
  rolls: number;
  nextLogId: number;
}

const initialDemo = (game: GameState): DemoState => ({ game, log: [], rolls: 0, nextLogId: 0 });

const rollAction = (state: GameState): GameAction => ({
  type: "roll",
  playerId: state.turn,
  value: 1 + Math.floor(Math.random() * 6),
});

/**
 * Siguiente acción de demostración: dado aleatorio y primera ficha legal.
 * No es la IA del juego; solo sirve para ver el tablero y el HUD conectados al motor.
 */
function nextDemoAction(state: GameState): GameAction {
  if (state.dice === null && state.pendingBonus === null) return rollAction(state);
  return { type: "move", playerId: state.turn, pieceIndex: getAvailableMoves(state)[0] };
}

export function BoardDemo() {
  const [demo, setDemo] = useState(() => initialDemo(createShowcaseState()));
  const [auto, setAuto] = useState(false);
  const { frame, animating, play, cancel } = useBoardAnimation();
  const { game } = demo;
  const finished = game.status === "finished";

  /** Aplica una acción al motor y lanza la animación de sus eventos. Ignorada mientras se anima. */
  const perform = useCallback(
    (action: GameAction) => {
      if (animating || demo.game.status === "finished") return;
      const result = applyAction(demo.game, action);
      if (!result.ok) return;

      let nextLogId = demo.nextLogId;
      const entries = result.events
        .map((event) => describeEvent(event, DEMO_PLAYER_NAMES))
        .filter((text): text is string => text !== null)
        .map((text) => ({ id: nextLogId++, text }))
        .reverse();

      setDemo({
        game: result.state,
        log: [...entries, ...demo.log].slice(0, LOG_SIZE),
        rolls: demo.rolls + (action.type === "roll" ? 1 : 0),
        nextLogId,
      });
      play(buildAnimation(demo.game, result.events, result.state));
    },
    [animating, demo, play],
  );

  const reset = (next: GameState) => {
    setAuto(false);
    cancel();
    setDemo(initialDemo(next));
  };

  // Modo automático: la siguiente acción espera a que termine la animación en curso.
  useEffect(() => {
    if (!auto || finished || animating) return;
    const id = setTimeout(() => perform(nextDemoAction(game)), AUTO_PAUSE_MS);
    return () => clearTimeout(id);
  }, [auto, finished, animating, game, perform]);

  const turn = getTurnInfo(game);
  const shownState = frame ? applyPositions(game, frame.positions) : game;

  return (
    <div className="grid w-full max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
      <section aria-label="Partida de demostración" className="flex min-w-0 flex-col items-center gap-3">
        <div className="w-full max-w-[min(100%,calc(100dvh_-_9rem))]">
          <ParchisBoard
            state={shownState}
            highlightedPieces={animating ? [] : getAvailableMoves(game)}
            movingKey={frame?.movingKey ?? null}
            transitionMs={frame?.durationMs}
          />
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => perform(nextDemoAction(game))} disabled={finished || animating || auto}>
            Siguiente acción
          </Button>
          <Button variant="secondary" onClick={() => setAuto((a) => !a)} disabled={finished}>
            {auto ? "Pausar" : "Automático"}
          </Button>
          <Button variant="outline" onClick={() => reset(createShowcaseState())}>
            Ejemplo
          </Button>
          <Button variant="outline" onClick={() => reset(createDemoGame())}>
            Partida nueva
          </Button>
        </div>
      </section>

      <aside aria-label="Información de la partida" className="flex min-w-0 flex-col gap-3">
        <DicePanel
          turn={turn}
          names={DEMO_PLAYER_NAMES}
          rollKey={demo.rolls}
          busy={animating}
          onRoll={auto ? undefined : () => perform(rollAction(game))}
        />
        <PlayersPanel players={getPlayerSummaries(game)} names={DEMO_PLAYER_NAMES} />
        <TurnLog entries={demo.log} />
      </aside>
    </div>
  );
}
