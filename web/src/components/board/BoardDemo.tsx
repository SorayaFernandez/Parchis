"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameView } from "@/components/game/GameView";
import { Button } from "@/components/ui/button";
import { applyPositions, buildAnimation } from "@/lib/board/animation";
import {
  createShowcaseState,
  newDemoMatch,
  nextDemoAction,
  rollDemoAction,
  stepDemo,
  type DemoMatch,
  type DemoRandom,
} from "@/lib/board/demo";
import type { GameAction } from "@/lib/engine";
import type { GameResponse } from "@/lib/game/api";
import { getTurnInfo } from "@/lib/hud/summary";
import { useBoardAnimation } from "./useBoardAnimation";

/** Pausa entre acciones en reproducción automática (después de la animación), como en la partida real. */
const AUTO_PAUSE_MS = 450;
/** Fecha fija de la vista (la demo no muestra fechas). */
const DEMO_DATE = "2026-01-01T00:00:00.000Z";

/** Azar al continuar la partida (la partida inicial ya viene calculada con su semilla). */
const browserRandom: DemoRandom = {
  rollDie: () => 1 + Math.floor(Math.random() * 6),
  ai: Math.random,
  chat: Math.random,
};

/** La demo con el aspecto de la partida real (`GameView`), sin guardarse ni conectarse a nada. */
function toGameResponse(match: DemoMatch): GameResponse {
  return {
    id: "demo",
    version: match.version,
    status: match.state.status,
    winner: match.state.winner,
    state: match.state,
    lastAction: match.lastAction,
    lastEvents: match.lastEvents,
    createdAt: DEMO_DATE,
    updatedAt: DEMO_DATE,
    finishedAt: null,
  };
}

/**
 * Partida de demostración de /tablero: los cuatro personajes juegan con el motor, la IA y el chat local
 * reales. Empieza en una partida avanzada y fija (`initial`, calculada al prerenderizar) y se reproduce
 * sola; se puede pausar, avanzar paso a paso, tirar el dado, reiniciar o empezar una partida nueva.
 */
export function BoardDemo({ initial }: { initial: DemoMatch }) {
  const [match, setMatch] = useState(initial);
  const [auto, setAuto] = useState(true);
  /** Hay una acción calculándose (el chat es asíncrono): no se empieza otra. */
  const [busy, setBusy] = useState(false);
  /** Versión de la última tirada: reinicia la animación del dado. */
  const [rollKey, setRollKey] = useState(0);
  const { frame, animating, play, cancel } = useBoardAnimation();
  // Cada reinicio invalida la acción que estuviera en curso (su resultado tardío se descarta).
  const generation = useRef(0);
  const { state } = match;
  const finished = state.status === "finished";
  const turn = getTurnInfo(state);

  const perform = useCallback(
    async (makeAction: (m: DemoMatch) => GameAction) => {
      if (animating || busy || match.state.status !== "playing") return;
      const gen = generation.current;
      setBusy(true);
      const next = await stepDemo(match, makeAction(match), browserRandom);
      if (gen !== generation.current) return;
      setBusy(false);
      if (!next) return;
      setMatch(next);
      if (next.lastAction?.type === "roll") setRollKey(next.version);
      play(buildAnimation(match.state, next.lastEvents, next.state));
    },
    [animating, busy, match, play],
  );

  const reset = (next: DemoMatch, autoplay: boolean) => {
    generation.current++;
    cancel();
    setBusy(false);
    setRollKey(0);
    setMatch(next);
    setAuto(autoplay);
  };

  // Reproducción automática: la siguiente acción espera a que termine la animación. Al pausar, el
  // temporizador se cancela enseguida y no empieza ninguna acción más.
  useEffect(() => {
    if (!auto || finished || animating || busy) return;
    const id = setTimeout(() => void perform((m) => nextDemoAction(m.state, browserRandom)), AUTO_PAUSE_MS);
    return () => clearTimeout(id);
  }, [auto, finished, animating, busy, perform]);

  // Como en la partida real, los mensajes de una jugada aparecen cuando el tablero termina de mostrarla.
  const boardVersion = animating ? match.version - 1 : match.version;
  const chat = useMemo(() => match.messages.filter((m) => m.version <= boardVersion), [match.messages, boardVersion]);
  const stepping = auto || animating || busy || finished;

  return (
    <GameView
      game={toGameResponse(match)}
      demo
      live={{
        boardState: frame ? applyPositions(state, frame.positions) : state,
        movingKey: frame?.movingKey ?? null,
        transitionMs: frame?.durationMs,
        animating,
        rollKey,
        log: match.log,
      }}
      chat={chat}
      controls={
        <>
          <Button size="sm" onClick={() => setAuto((a) => !a)} disabled={finished} aria-pressed={auto && !finished}>
            {auto && !finished ? "Pausar" : "Reproducir"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void perform((m) => nextDemoAction(m.state, browserRandom))} disabled={stepping}>
            Siguiente acción
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void perform((m) => rollDemoAction(m.state, browserRandom))} disabled={stepping || !turn.canRoll}>
            Lanzar dado
          </Button>
          <Button size="sm" variant="outline" onClick={() => reset(initial, true)}>
            Reiniciar demo
          </Button>
          <Button size="sm" variant="outline" onClick={() => reset(newDemoMatch(), true)}>
            Partida nueva
          </Button>
          <Button size="sm" variant="outline" onClick={() => reset(newDemoMatch(createShowcaseState()), false)}>
            Ejemplo
          </Button>
        </>
      }
    />
  );
}
