// Opciones de movimiento para el selector estratégico con LLM (puro: sin red ni React).
// La única fuente de movimientos legales es `getAvailableMoves(state)`. Cada opción se SIMULA con
// `applyAction`, y todo lo que se describe sale de esa simulación (eventos y estado resultante) o de
// funciones del motor (`getBlockades`, `isSafeCell`, `canMovePiece`): aquí no se reproduce ninguna regla.
// Cada opción recibe un identificador temporal (A, B, C…). La correspondencia identificador → ficha
// (`pieceIndex`) se queda en el servidor: el prompt solo envía los identificadores y los hechos.

import {
  applyAction,
  canMovePiece,
  getAvailableMoves,
  getBlockades,
  getMoveDistance,
  getRealBoardPosition,
  isOnMainTrack,
  isSafeCell,
  PIECES_PER_PLAYER,
  type BonusReason,
  type GameEvent,
  type GameState,
  type Piece,
  type PiecePosition,
  type PlayerId,
} from "@/lib/engine";

/** Valores posibles del dado en la siguiente tirada (para amenazas y oportunidades). */
const DIE_VALUES = [1, 2, 3, 4, 5, 6] as const;

const OPTION_IDS = ["A", "B", "C", "D"] as const;
export type MoveOptionId = (typeof OPTION_IDS)[number];

/** Posición de una ficha en palabras del parchís (siempre relativa a su propio color). */
export type PositionFact =
  | { zone: "casa" }
  /** `casillas`: casillas recorridas desde su salida (0–63; 63 es la entrada al pasillo). */
  | { zone: "recorrido"; casillas: number }
  /** `casilla`: 1–7 de las casillas de color del pasillo final. */
  | { zone: "pasillo"; casilla: number }
  | { zone: "meta" };

/** Hechos de una opción, todos obtenidos de la simulación con el motor. */
export interface MoveFacts {
  desde: PositionFact;
  hasta: PositionFact;
  /** Casillas que avanza (la distancia del dado o del bonus). */
  avance: number;
  saleDeCasa: boolean;
  /** Ficha rival capturada (`piece_captured`), o `null`. */
  captura: { jugador: PlayerId } | null;
  llegaAMeta: boolean;
  /** Pasa del recorrido común a las casillas de color del pasillo final. */
  entraEnPasillo: boolean;
  /** Termina en una casilla segura del recorrido. */
  casillaSegura: boolean;
  /** Forma una barrera con otra ficha suya en la casilla de destino (`getBlockades` antes/después). */
  formaBarrera: boolean;
  /** Deshace una barrera en la que estaba esta ficha (`getBlockades` antes/después). */
  rompeBarrera: boolean;
  /**
   * Fichas rivales que podrían capturar esta ficha en su próxima tirada (con algún valor del dado),
   * simulando su jugada con el motor. `null` si la ficha no queda en el recorrido común.
   */
  amenazas: number | null;
  /**
   * Fichas rivales que esta ficha podría capturar en la tirada siguiente de quien mueve (con algún
   * valor del dado), simulado con el motor. `null` si no queda en el recorrido común.
   */
  presas: number | null;
  /** Bonus que gana con el movimiento (`bonus_granted`): +20 por captura, +10 por meta. */
  bonusGanado: { cantidad: number; motivo: BonusReason } | null;
  /** Después del movimiento vuelve a tirar (`roll_again`). */
  repiteTirada: boolean;
}

export interface MoveOption {
  id: MoveOptionId;
  /** Solo en el servidor: nunca se envía al modelo. */
  pieceIndex: number;
  facts: MoveFacts;
}

/** Qué distancia se está jugando: la tirada del dado o un bonus pendiente. */
export type MoveSource =
  | { tipo: "dado"; valor: number }
  | { tipo: "bonus"; cantidad: number; motivo: BonusReason };

/** Obligación del motor que limita las opciones (con un 5, sacar ficha; con un 6, abrir barrera). */
export type MoveObligation = "sacar ficha de casa" | "abrir una barrera propia" | null;

export interface MoveDecision {
  playerId: PlayerId;
  source: MoveSource;
  obligation: MoveObligation;
  options: MoveOption[];
}

function positionOf(position: PiecePosition): PositionFact {
  switch (position.state) {
    case "base":
      return { zone: "casa" };
    case "track":
      return { zone: "recorrido", casillas: position.steps };
    case "final":
      // `steps` 68..74 → casillas 1..7 del pasillo de color.
      return { zone: "pasillo", casilla: position.steps - 67 };
    case "finished":
      return { zone: "meta" };
  }
}

const cellOf = (state: GameState, playerId: PlayerId, piece: Piece): number | null => {
  if (!isOnMainTrack(piece)) return null;
  const color = state.players.find((p) => p.id === playerId)!.color;
  return getRealBoardPosition(color, piece.steps);
};

/** Barreras del motor en las que participa una ficha de `playerId` en la casilla `cell`. */
function ownBlockadeAt(state: GameState, playerId: PlayerId, cell: number | null): boolean {
  if (cell === null) return false;
  const color = state.players.find((p) => p.id === playerId)!.color;
  return getBlockades(state).some((b) => b.cell === cell && (b.color === color || b.color === null));
}

/**
 * Fichas de `attacker` que capturarían la ficha `victimPieceIndex` de `victim` en la tirada siguiente,
 * con algún valor del dado: se simula con el motor la jugada de `attacker` en un estado hipotético en el
 * que le toca con ese dado (sin bonus pendiente). Respeta todas las reglas del motor (seguros, barreras,
 * salidas con 5, obligaciones…), porque es `applyAction` quien decide.
 */
function capturersOf(state: GameState, attacker: PlayerId, victim: PlayerId, victimPieceIndex: number): Set<number> {
  const found = new Set<number>();
  for (const value of DIE_VALUES) {
    const hypothetical: GameState = { ...state, turn: attacker, dice: value, pendingBonus: null, sixesInTurn: 0 };
    for (const pieceIndex of getAvailableMoves(hypothetical)) {
      const result = applyAction(hypothetical, { type: "move", playerId: attacker, pieceIndex });
      if (!result.ok) continue;
      const captures = result.events.some((e) => e.type === "piece_captured" && e.victimId === victim && e.victimPieceIndex === victimPieceIndex);
      if (captures) found.add(pieceIndex);
    }
  }
  return found;
}

/** Amenazas: fichas rivales (que siguen jugando) que podrían capturar la ficha movida. */
function threatsTo(state: GameState, playerId: PlayerId, pieceIndex: number): number {
  let total = 0;
  for (const rival of state.players) {
    if (rival.id === playerId || state.ranking.includes(rival.id)) continue;
    total += capturersOf(state, rival.id, playerId, pieceIndex).size;
  }
  return total;
}

/** Presas: fichas rivales que la ficha movida podría capturar en la tirada siguiente de quien mueve. */
function preyFor(state: GameState, playerId: PlayerId, pieceIndex: number): number {
  const prey = new Set<string>();
  for (const value of DIE_VALUES) {
    const hypothetical: GameState = { ...state, turn: playerId, dice: value, pendingBonus: null, sixesInTurn: 0 };
    if (!getAvailableMoves(hypothetical).includes(pieceIndex)) continue;
    const result = applyAction(hypothetical, { type: "move", playerId, pieceIndex });
    if (!result.ok) continue;
    for (const e of result.events) if (e.type === "piece_captured") prey.add(`${e.victimId}:${e.victimPieceIndex}`);
  }
  return prey.size;
}

const movedEvent = (events: readonly GameEvent[]) =>
  events.find((e): e is Extract<GameEvent, { type: "piece_moved" }> => e.type === "piece_moved");

/** Hechos de mover `pieceIndex` (simulado con `applyAction`). `null` si el motor lo rechaza. */
export function simulateOption(state: GameState, pieceIndex: number): MoveFacts | null {
  const playerId = state.turn;
  const result = applyAction(state, { type: "move", playerId, pieceIndex });
  if (!result.ok) return null;
  const moved = movedEvent(result.events);
  if (!moved) return null;

  const before = state.players.find((p) => p.id === playerId)!.pieces[pieceIndex];
  const after = result.state.players.find((p) => p.id === playerId)!.pieces[pieceIndex];
  const fromCell = cellOf(state, playerId, before);
  const toCell = cellOf(result.state, playerId, after);
  const captured = result.events.find((e): e is Extract<GameEvent, { type: "piece_captured" }> => e.type === "piece_captured");
  const bonus = result.events.find((e): e is Extract<GameEvent, { type: "bonus_granted" }> => e.type === "bonus_granted");

  return {
    desde: positionOf(moved.from),
    hasta: positionOf(moved.to),
    avance: moved.distance,
    saleDeCasa: moved.from.state === "base",
    captura: captured ? { jugador: captured.victimId } : null,
    llegaAMeta: result.events.some((e) => e.type === "piece_reached_goal"),
    entraEnPasillo: moved.from.state !== "final" && moved.to.state === "final",
    casillaSegura: toCell !== null && isSafeCell(toCell),
    formaBarrera: !ownBlockadeAt(state, playerId, toCell) && ownBlockadeAt(result.state, playerId, toCell),
    rompeBarrera: ownBlockadeAt(state, playerId, fromCell) && !ownBlockadeAt(result.state, playerId, fromCell),
    amenazas: toCell === null ? null : threatsTo(result.state, playerId, pieceIndex),
    presas: toCell === null ? null : preyFor(result.state, playerId, pieceIndex),
    bonusGanado: bonus ? { cantidad: bonus.amount, motivo: bonus.reason } : null,
    repiteTirada: result.events.some((e) => e.type === "roll_again"),
  };
}

/**
 * Decisión pendiente del jugador en turno: la distancia que se juega (dado o bonus), la obligación del
 * motor si la hay y las opciones legales (A, B, C… en orden de ficha). `null` si no hay nada que decidir:
 * partida terminada, sin dado ni bonus o sin movimientos legales.
 */
export function buildMoveDecision(state: GameState): MoveDecision | null {
  if (state.status !== "playing") return null;
  const distance = getMoveDistance(state);
  if (distance === null) return null;
  const legal = getAvailableMoves(state);
  if (legal.length === 0) return null;

  const options: MoveOption[] = [];
  for (const pieceIndex of legal) {
    const facts = simulateOption(state, pieceIndex);
    // `getAvailableMoves` y `applyAction` coinciden (lo comprueban las pruebas del motor); si alguna vez
    // no fuera así, la opción no se ofrece.
    if (!facts) continue;
    options.push({ id: OPTION_IDS[options.length], pieceIndex, facts });
  }
  if (options.length === 0) return null;

  // Obligación: fichas que el motor dejaría mover por sí solas (`canMovePiece`) pero que no están entre
  // las legales, porque una obligación (sacar ficha con un 5, abrir barrera con un 6) las excluye.
  const playerId = state.turn;
  const movable = Array.from({ length: PIECES_PER_PLAYER }, (_, i) => i).filter((i) => canMovePiece(state, playerId, i, distance).ok);
  const excluded = movable.some((i) => !legal.includes(i));
  const obligation: MoveObligation = !excluded
    ? null
    : options.every((o) => o.facts.saleDeCasa)
      ? "sacar ficha de casa"
      : options.every((o) => o.facts.rompeBarrera)
        ? "abrir una barrera propia"
        : null;

  const source: MoveSource = state.pendingBonus
    ? { tipo: "bonus", cantidad: state.pendingBonus.amount, motivo: state.pendingBonus.reason }
    : { tipo: "dado", valor: distance };

  return { playerId, source, obligation, options };
}

/** Ficha (`pieceIndex`) de un identificador de opción, o `null` si no es una de las opciones. */
export function pieceForOption(decision: MoveDecision, id: string): number | null {
  return decision.options.find((o) => o.id === id)?.pieceIndex ?? null;
}
