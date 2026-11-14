// Decisión de la acción con el selector estratégico (fase 8.3, F3). Solo cambia CÓMO se elige la ficha
// cuando hay dos o más movimientos legales; todo lo demás es exactamente `decideAction` (ai.ts):
// - Sin dado ni bonus: tirar (nunca se consulta al LLM).
// - Sin movimientos legales: `timeout` (estado anómalo; nunca se consulta al LLM).
// - Una sola opción: esa ficha, sin consultar al LLM.
// - Dos o más: se consulta al selector con las opciones de F1 (`buildMoveDecision`). Su elección se
//   valida contra esa decisión (identificador y ficha), contra `getAvailableMoves` del estado reservado y
//   con `applyAction`. Si algo falla (error, timeout, cancelación, corte temporal, respuesta no válida,
//   opción que no corresponde o movimiento ilegal), se usa la estrategia local (`decideAction` →
//   `chooseMove`) exactamente una vez. Nunca impide que la partida avance.
// - Cupo (F4): justo antes de consultar al selector se consume una consulta del cupo de la partida
//   (`consumeQuota`, 20 por partida en Upstash). Solo ahí: nunca al tirar, sin movimientos, con una sola
//   opción ni sin selector. Si el cupo se ha agotado, no está disponible o falta, se usa la estrategia
//   local sin consultar (falla cerrado). La consulta consumida cuenta aunque el modelo falle o tarde.

import { applyAction, getAvailableMoves, type GameAction, type GameState } from "@/lib/engine";
import { decideAction, type RandomSource } from "@/lib/game/ai";
import type { MoveSelector } from "./gateway";
import type { QuotaResult } from "./quota";
import { buildMoveDecision } from "./options";

/** Por qué se ha usado la estrategia local después de consultar al selector (textos fijos). */
export type MoveFallbackReason =
  /** El selector devolvió un fallo (su error ya lo registra él). */
  | "fallo del selector"
  /** El identificador o la ficha no corresponden a la decisión enviada. */
  | "opción no válida"
  /** La ficha no es legal en el estado reservado o el motor la rechaza. */
  | "movimiento ilegal"
  /** El selector lanzó una excepción (no debería: nunca lanza). */
  | "excepción del selector"
  /** Ya se han hecho las 20 consultas de la partida (no se consulta). */
  | "cupo agotado"
  /** No se pudo confirmar el cupo (Redis falla, tarda o no está configurado): no se consulta. */
  | "cupo no disponible";

export interface DecideWithSelectorDeps {
  rollDie: () => number;
  random?: RandomSource;
  /** Sin selector, el comportamiento es exactamente `decideAction`. */
  selector?: MoveSelector;
  /** Cancelación de quien llama (p. ej., la petición HTTP); se pasa al selector. */
  signal?: AbortSignal;
  /** Consume una consulta del cupo de la partida. Sin él, el selector no se consulta (falla cerrado). */
  consumeQuota?: () => Promise<QuotaResult>;
  /** Aviso cuando, tras consultar al selector, se usa la estrategia local. */
  onFallback?: (reason: MoveFallbackReason) => void;
}

export interface DecidedAction {
  action: GameAction;
  /** `llm`: la ficha la eligió el selector; `local`: la estrategia local (o no había nada que elegir). */
  source: "llm" | "local";
}

export async function decideActionWithSelector(state: GameState, deps: DecideWithSelectorDeps): Promise<DecidedAction> {
  const local = (): DecidedAction => ({ action: decideAction(state, deps.rollDie, deps.random), source: "local" });

  // Tiradas, partida terminada, sin movimientos, una sola opción o sin selector: igual que antes.
  if (!deps.selector || state.status !== "playing" || (state.dice === null && state.pendingBonus === null)) return local();
  const legal = getAvailableMoves(state);
  if (legal.length < 2) return local();

  const fallback = (reason: MoveFallbackReason): DecidedAction => {
    deps.onFallback?.(reason);
    return local();
  };

  // Si no se va a llamar al modelo (corte temporal activo o petición ya cancelada), no se consume cupo:
  // el selector devolvería el fallo al instante.
  if (deps.selector.isAvailable?.() === false || deps.signal?.aborted) {
    return fallback("fallo del selector");
  }

  // Cupo: solo aquí, justo antes de consultar. Sin cupo confirmado, estrategia local sin consultar.
  let quota: QuotaResult;
  try {
    quota = deps.consumeQuota ? await deps.consumeQuota() : { kind: "unavailable" };
  } catch {
    quota = { kind: "unavailable" };
  }
  if (quota.kind === "exhausted") return fallback("cupo agotado");
  if (quota.kind !== "allowed") return fallback("cupo no disponible");

  // Las opciones (con sus simulaciones) se construyen solo cuando se va a consultar: agotado el cupo, la
  // estrategia local no paga ese coste. Con 2+ movimientos legales siempre hay 2+ opciones (`applyAction`
  // acepta todo lo que da `getAvailableMoves`); si no fuera así, estrategia local.
  const decision = buildMoveDecision(state);
  if (!decision || decision.options.length < 2) return local();

  let selection: Awaited<ReturnType<MoveSelector["select"]>>;
  try {
    selection = await deps.selector.select(state, decision, { signal: deps.signal });
  } catch {
    return fallback("excepción del selector");
  }
  if (!selection.ok) return fallback("fallo del selector");

  // La elección debe ser exactamente una opción de ESTA decisión (identificador y ficha juntos).
  const option = decision.options.find((o) => o.id === selection.id && o.pieceIndex === selection.pieceIndex);
  if (!option) return fallback("opción no válida");

  // Y seguir siendo legal en el estado reservado: el motor tiene la última palabra.
  if (!getAvailableMoves(state).includes(option.pieceIndex)) return fallback("movimiento ilegal");
  const action: GameAction = { type: "move", playerId: state.turn, pieceIndex: option.pieceIndex };
  if (!applyAction(state, action).ok) return fallback("movimiento ilegal");
  return { action, source: "llm" };
}
