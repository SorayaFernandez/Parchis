// Partida de demostración de /tablero, solo en el navegador (o al prerenderizar la página). No es parte
// del juego: no usa Supabase, Realtime, la API ni el LLM. Reutiliza sin cambios lo mismo que la partida
// real: el motor (`applyAction`), la IA de cada personaje (`decideAction`) y el chat local (el procesador
// `processBatch` con el director y el escritor de frases locales, sin cola ni reservas).

import type { TurnLogEntry } from "@/components/hud/TurnLog";
import { initialDirectorState } from "@/lib/chat/director";
import type { ChatMessage, ChatTrigger, DirectorState } from "@/lib/chat/schemas";
import { processBatch } from "@/lib/chat/service";
import type { ChatStore } from "@/lib/chat/store";
import { createLocalWriter } from "@/lib/chat/writer";
import {
  FINAL_POSITION,
  MAIN_TRACK_SIZE,
  START_POSITIONS,
  applyAction,
  createGame,
  type Color,
  type GameAction,
  type GameEvent,
  type GameState,
} from "@/lib/engine";
import { createSeededRandom, decideAction, type RandomSource } from "@/lib/game/ai";
import { CHARACTER_IDS, CHARACTER_NAMES } from "@/lib/game/characters";
import { describeEvent } from "@/lib/hud/events";
import { pieceStateForSteps } from "./journey";

/** Semilla y número de acciones de la partida inicial (elegidas para una partida avanzada y variada). */
export const DEMO_SEED = 4;
export const DEMO_START_ACTIONS = 300;
/** Entradas de «Últimas jugadas» que se conservan (las mismas que en la partida en directo). */
export const DEMO_LOG_SIZE = 60;

/** Estado completo de la demo. Es serializable: la partida inicial se calcula al prerenderizar. */
export interface DemoMatch {
  state: GameState;
  /** Como en la partida real: 1 al crearla y +1 por acción. */
  version: number;
  lastAction: GameAction | null;
  lastEvents: GameEvent[];
  /** Jugadas, de la más reciente a la más antigua. */
  log: TurnLogEntry[];
  /** Mensajes del chat, en orden (versión → `seq`). */
  messages: ChatMessage[];
  director: DirectorState;
}

export interface DemoRandom {
  /** Valor del dado (1–6). */
  rollDie: () => number;
  /** Azar de la IA (Chispa). */
  ai: RandomSource;
  /** Azar del chat (director y elección de frases). */
  chat: RandomSource;
}

/** Partida nueva con los cuatro personajes (en el orden interno de siempre). */
export function newDemoMatch(state: GameState = createGame([...CHARACTER_IDS])): DemoMatch {
  return { state, version: 1, lastAction: null, lastEvents: [], log: [], messages: [], director: initialDirectorState() };
}

/** Siguiente acción del personaje en turno: la IA del juego con su perfil (sin inventar movimientos). */
export function nextDemoAction(state: GameState, random: DemoRandom): GameAction {
  return decideAction(state, random.rollDie, random.ai);
}

/** Tirada del dado del jugador en turno (botón «Lanzar dado»). */
export function rollDemoAction(state: GameState, random: DemoRandom): GameAction {
  return { type: "roll", playerId: state.turn, value: random.rollDie() };
}

// El procesador del chat no usa el almacén (solo `drainChat` lo usa): la demo no lo tiene.
const NO_STORE = new Proxy({} as ChatStore, {
  get: () => () => Promise.reject(new Error("La demo no tiene almacén de chat")),
});

/**
 * Aplica una acción con el motor (si no es legal, `null`) y, como hace el servidor tras cada avance,
 * las jugadas y los comentarios del chat de esa versión. Nunca modifica `match`.
 */
export async function stepDemo(match: DemoMatch, action: GameAction, random: DemoRandom): Promise<DemoMatch | null> {
  const result = applyAction(match.state, action);
  if (!result.ok) return null;
  const version = match.version + 1;

  const entries = result.events
    .map((event) => describeEvent(event, CHARACTER_NAMES))
    .filter((text): text is string => text !== null)
    .reverse()
    .map((text, i) => ({ id: version * 100 + i, text }));

  // Chat: la misma versión que encolaría el trigger, procesada por el procesador real con las frases
  // locales (sin LLM). Sin acontecimientos que comentar, no dice nada.
  const writer = createLocalWriter(random.chat);
  const isVictory = result.events.some((e) => e.type === "player_finished" && e.place === 1);
  const chat = await processBatch(
    {
      items: [{ version, events: result.events, state: result.state, isVictory, attempts: 1 }],
      lastVersion: match.version,
      through: version,
      latest: version,
      messageCount: match.messages.length,
      directorState: match.director,
    },
    { store: NO_STORE, writer, fallbackWriter: writer, random: random.chat, newToken: () => "demo" },
  );
  // El escritor local no falla; si fallara, la versión se queda sin comentarios y la partida sigue.
  const ok = chat.error === undefined;
  let nextId = (match.messages.at(-1)?.id ?? 0) + 1;
  const messages: ChatMessage[] = ok
    ? chat.messages.map((m) => ({
        id: nextId++,
        version: m.version,
        seq: m.seq,
        characterId: m.character_id,
        trigger: m.trigger as ChatTrigger,
        replyToSeq: m.reply_to_seq,
        text: m.text,
        createdAt: DEMO_DATE,
      }))
    : [];

  return {
    state: result.state,
    version,
    lastAction: action,
    lastEvents: result.events,
    log: [...entries, ...match.log].slice(0, DEMO_LOG_SIZE),
    messages: [...match.messages, ...messages],
    director: ok ? chat.director : match.director,
  };
}

/** Fecha fija de los mensajes de la demo (no se muestra; mantiene la partida inicial reproducible). */
const DEMO_DATE = "2026-01-01T00:00:00.000Z";

/** Azar reproducible a partir de una semilla (dado, IA y chat con generadores independientes). */
export function seededDemoRandom(seed: number): DemoRandom {
  const dice = createSeededRandom(seed);
  return { rollDie: () => 1 + Math.floor(dice() * 6), ai: createSeededRandom(seed + 1), chat: createSeededRandom(seed + 2) };
}

/**
 * Partida inicial: desde el principio, `actions` acciones de la IA con el azar de `seed`. Determinista:
 * la misma semilla da el mismo estado, las mismas jugadas y los mismos mensajes. Si la partida terminara
 * antes, se detiene ahí.
 */
export async function createDemoMatch(seed = DEMO_SEED, actions = DEMO_START_ACTIONS): Promise<DemoMatch> {
  const random = seededDemoRandom(seed);
  let match = newDemoMatch();
  for (let i = 0; i < actions && match.state.status === "playing"; i++) {
    const next = await stepDemo(match, nextDemoAction(match.state, random), random);
    if (!next) throw new Error("La IA ha propuesto una acción ilegal");
    match = next;
  }
  return match;
}

/** `steps` de un color para estar en una casilla global del recorrido. */
function stepsAtCell(color: Color, cell: number): number {
  return (cell - START_POSITIONS[color] + MAIN_TRACK_SIZE) % MAIN_TRACK_SIZE;
}

/**
 * «Casos del tablero» (botón Ejemplo): un caso de cada con los cuatro personajes. Fichas en casa, en la
 * salida, una barrera, dos colores en un seguro, fichas en los cuatro pasillos finales y en la meta.
 */
export function createShowcaseState(): GameState {
  const state = createGame([...CHARACTER_IDS]);
  const layout: Record<Color, number[]> = {
    pink: [-1, -1, 0, 70],
    purple: [stepsAtCell("purple", 44), stepsAtCell("purple", 44), FINAL_POSITION, 69],
    green: [stepsAtCell("green", 63), 71, FINAL_POSITION, FINAL_POSITION],
    blue: [stepsAtCell("blue", 63), 68, -1, 72],
  };

  let order = 0;
  for (const player of state.players) {
    player.pieces = layout[player.color].map((steps) => ({
      steps,
      state: pieceStateForSteps(steps),
      arrivalOrder: ++order,
    }));
  }
  state.moveCounter = order;
  return state;
}
