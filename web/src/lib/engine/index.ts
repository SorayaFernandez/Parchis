// API pública del motor de Parchís.

export * from "./types";
export * from "./constants";
export { applyAction, createGame, getAvailableMoves } from "./engine";
export {
  getBlockades,
  getDistanceToHomeEntry,
  getRealBoardPosition,
  isOnMainTrack,
  isSafeCell,
} from "./board";
export { canMovePiece, getLegalMoves, getMoveDistance } from "./moves";
