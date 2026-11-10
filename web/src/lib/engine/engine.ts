// Punto de entrada del motor: crear partida y aplicar acciones.
// Sustituye a backend/game/gameEngine.js (executeMove, executeBonusMove), a la
// tirada de backend/controllers/gameController.js y al cambio de turno por tiempo
// de backend/game/turnTimer.js, sin temporizadores, I/O ni aleatoriedad.

import {
  BASE_STEPS,
  CAPTURE_BONUS,
  COLORS,
  EXTRA_ROLL_VALUE,
  GOAL_BONUS,
  MAX_CONSECUTIVE_SIXES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PIECES_PER_PLAYER,
  TURN_ORDER,
} from "./constants";
import {
  applyPieceMove,
  canMovePiece,
  getLegalMoves,
  getMoveDistance,
  getPlayer,
  hasFinishedAllPieces,
  resolveCapture,
  sendPieceToBase,
  toPosition,
} from "./moves";
import { passTurn } from "./turns";
import type {
  ActionResult,
  BonusReason,
  GameAction,
  GameEvent,
  GameState,
  Piece,
  PlayerId,
} from "./types";

function createPieces(): Piece[] {
  return Array.from({ length: PIECES_PER_PLAYER }, () => ({
    state: "base" as const,
    steps: BASE_STEPS,
    arrivalOrder: 0,
  }));
}

/**
 * Crea una partida ya en juego. Los colores se asignan en el orden de `COLORS`
 * (como `addPlayerToGame` del original) y empieza el primero según `TURN_ORDER`.
 */
export function createGame(playerIds: PlayerId[]): GameState {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new RangeError(`Se necesitan entre ${MIN_PLAYERS} y ${MAX_PLAYERS} jugadores`);
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new RangeError("Los ids de jugador deben ser únicos");
  }

  const players = playerIds.map((id, i) => ({
    id,
    color: COLORS[i],
    pieces: createPieces(),
  }));
  const first = TURN_ORDER.map((c) => players.find((p) => p.color === c)).find(
    (p) => p !== undefined,
  )!;

  return {
    status: "playing",
    players,
    turn: first.id,
    dice: null,
    lastDice: null,
    sixesInTurn: 0,
    lastMovedPiece: null,
    pendingBonus: null,
    ranking: [],
    winner: null,
    moveCounter: 0,
  };
}

/** Movimientos legales del jugador en turno con el dado o el bonus pendiente. */
export function getAvailableMoves(state: GameState): number[] {
  const distance = getMoveDistance(state);
  if (state.status !== "playing" || distance === null) return [];
  return getLegalMoves(state, state.turn, distance);
}

/** Aplica una acción sin modificar `state`. Devuelve el nuevo estado y los eventos. */
export function applyAction(state: GameState, action: GameAction): ActionResult {
  if (state.status === "finished") return { ok: false, error: "GAME_FINISHED" };

  switch (action.type) {
    case "roll":
      return roll(state, action.playerId, action.value);
    case "move":
      return move(state, action.playerId, action.pieceIndex);
    case "timeout":
      return timeout(state);
  }
}

function roll(state: GameState, playerId: PlayerId, value: number): ActionResult {
  if (state.turn !== playerId) return { ok: false, error: "NOT_YOUR_TURN" };
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    return { ok: false, error: "INVALID_DICE_VALUE" };
  }
  if (state.pendingBonus) return { ok: false, error: "BONUS_PENDING" };
  if (state.dice !== null) return { ok: false, error: "DICE_ALREADY_ROLLED" };

  const next = structuredClone(state);
  const events: GameEvent[] = [{ type: "dice_rolled", playerId, value }];
  next.lastDice = value;

  if (value === EXTRA_ROLL_VALUE) {
    next.sixesInTurn++;
    if (next.sixesInTurn >= MAX_CONSECUTIVE_SIXES) {
      applyThirdSixPenalty(next, playerId, events);
      passTurn(next, events);
      return { ok: true, state: next, events };
    }
  }

  next.dice = value;
  if (getLegalMoves(next, playerId, value).length === 0) {
    events.push({ type: "no_moves", playerId, value });
    next.dice = null;
    if (value === EXTRA_ROLL_VALUE) events.push({ type: "roll_again", playerId });
    else passTurn(next, events);
  }

  return { ok: true, state: next, events };
}

/**
 * Tercer seis seguido: la última ficha que movió el jugador vuelve a casa y pierde el turno.
 * El original solo devolvía la ficha si no se podía mover y no pasaba el turno.
 * Si se podía mover, dejaba mover con el tercer seis y devolvía esa misma ficha.
 */
function applyThirdSixPenalty(
  state: GameState,
  playerId: PlayerId,
  events: GameEvent[],
): void {
  const ref = state.lastMovedPiece;
  let pieceIndex: number | null = null;
  if (ref && ref.playerId === playerId) {
    const piece = getPlayer(state, playerId)?.pieces[ref.pieceIndex];
    if (piece) {
      sendPieceToBase(piece);
      pieceIndex = ref.pieceIndex;
    }
  }
  state.lastMovedPiece = null;
  events.push({ type: "third_six_penalty", playerId, pieceIndex });
}

function move(state: GameState, playerId: PlayerId, pieceIndex: number): ActionResult {
  if (state.turn !== playerId) return { ok: false, error: "NOT_YOUR_TURN" };

  const distance = getMoveDistance(state);
  if (distance === null) return { ok: false, error: "ROLL_FIRST" };

  const validation = canMovePiece(state, playerId, pieceIndex, distance);
  if (!validation.ok) return validation;
  // Se valida contra los movimientos legales (no solo contra canMovePiece). Así se
  // aplica en el servidor la obligación de abrir barrera con un 6, que en el original
  // solo se respetaba en la interfaz.
  if (!getLegalMoves(state, playerId, distance).includes(pieceIndex)) {
    return { ok: false, error: "MUST_BREAK_BLOCKADE" };
  }

  const next = structuredClone(state);
  const events: GameEvent[] = [];
  const player = getPlayer(next, playerId)!;
  const piece = player.pieces[pieceIndex];
  const withBonus = next.pendingBonus !== null;
  // Con un bonus, se vuelve a tirar si el movimiento que lo generó fue con un 6.
  const rollAgain = next.pendingBonus
    ? next.pendingBonus.fromSix
    : distance === EXTRA_ROLL_VALUE;

  const from = toPosition(piece);
  const { leftBase, reachedGoal } = applyPieceMove(next, player, pieceIndex, distance);
  next.lastMovedPiece = { playerId, pieceIndex };
  next.dice = null;
  next.pendingBonus = null;
  events.push({
    type: "piece_moved",
    playerId,
    pieceIndex,
    distance,
    from,
    to: toPosition(piece),
    withBonus,
  });

  const capture = resolveCapture(next, player, piece, leftBase);
  if (capture) events.push({ type: "piece_captured", playerId, ...capture });
  if (reachedGoal) events.push({ type: "piece_reached_goal", playerId, pieceIndex });

  // Si el jugador ha terminado, nunca conserva el turno. El original no reiniciaba
  // el dado y, si tenía un bonus de un 6, le dejaba volver a tirar.
  if (hasFinishedAllPieces(player)) {
    finishPlayer(next, playerId, events);
    return { ok: true, state: next, events };
  }

  // Un bonus se puede encadenar también en un movimiento de bonus. En el original
  // eso solo ocurría dentro de `if (won)`.
  const reason: BonusReason | null = capture ? "capture" : reachedGoal ? "goal" : null;
  if (reason) {
    const amount = reason === "capture" ? CAPTURE_BONUS : GOAL_BONUS;
    if (getLegalMoves(next, playerId, amount).length > 0) {
      next.pendingBonus = { playerId, amount, reason, fromSix: rollAgain };
      events.push({ type: "bonus_granted", playerId, amount, reason });
      return { ok: true, state: next, events };
    }
    events.push({ type: "bonus_lost", playerId, amount, reason });
  }

  if (rollAgain) events.push({ type: "roll_again", playerId });
  else passTurn(next, events);
  return { ok: true, state: next, events };
}

function finishPlayer(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  state.ranking.push(playerId);
  events.push({ type: "player_finished", playerId, place: state.ranking.length });

  const remaining = state.players.filter((p) => !state.ranking.includes(p.id));
  if (remaining.length <= 1) {
    for (const p of remaining) state.ranking.push(p.id);
    state.status = "finished";
    state.winner = state.ranking[0];
    state.dice = null;
    state.pendingBonus = null;
    events.push({
      type: "game_finished",
      winner: state.winner,
      ranking: [...state.ranking],
    });
    return;
  }
  passTurn(state, events);
}

/** Vence el plazo del turno: se pierde el dado o el bonus pendiente y pasa el turno. */
function timeout(state: GameState): ActionResult {
  const next = structuredClone(state);
  const events: GameEvent[] = [{ type: "turn_timeout", playerId: next.turn }];
  passTurn(next, events);
  return { ok: true, state: next, events };
}
