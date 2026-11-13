// Director del chat (puro y determinista con un azar inyectado).
// Decide, a partir de los eventos REALES de una versión, si alguien habla, quién, de qué tipo
// (`ChatLineKind`) y si hay una réplica. No escribe el texto: eso lo hace un `ChatWriter`
// (frases locales ahora; un LLM en la fase 8.2b), así que el director no cambia al sustituirlo.

import type { GameEvent, GameState, PlayerId } from "@/lib/engine";
import { getCharacter, type ChatLineKind } from "@/lib/game/characters";
import { getPlayerSummaries } from "@/lib/hud/summary";
import { addCatchphrases, detectCatchphrases } from "./catchphrases";
import { CHAT_LIMITS, REPLY_CHANCE, TRIGGER_CHANCE } from "./config";
import type { ChatTrigger, DirectorState } from "./schemas";

/** Generador en [0, 1). */
export type Random = () => number;

/** Una intervención decidida por el director (sin texto). */
export interface Utterance {
  speaker: PlayerId;
  kind: ChatLineKind;
  trigger: ChatTrigger;
  /** Otro personaje implicado (el `{rival}` de la frase), si lo hay. */
  rival: PlayerId | null;
  /** Índice, en el mismo plan, del mensaje al que responde. */
  replyTo: number | null;
  /** Victoria y capturas: en 8.2b, si falla el LLM, se usa la frase local en vez de callar. */
  important: boolean;
  /**
   * Datos reales de una racha (solo en `streak_boast`/`streak_lament`): capturas en la ventana y si
   * fueron todas seguidas (ninguna otra captura entre medias). Las frases los usan con `{count}` y
   * `{ritmo}`, así que nunca dicen "dos" si fueron tres, ni "seguidas" si no lo fueron.
   */
  streak?: StreakFacts;
}

export interface StreakFacts {
  count: number;
  consecutive: boolean;
}

type CaptureLog = DirectorState["captures"];

/**
 * Racha de `who` como captor (`by`) o como víctima (`victim`) en las capturas recientes (la actual
 * incluida): total en la ventana y cuántas de las últimas capturas de la partida son suyas sin
 * interrupción. Es racha si suma `streakSize` o si las últimas `consecutiveStreakSize` son seguidas.
 */
export function streakOf(captures: CaptureLog, who: PlayerId, role: "by" | "victim"): StreakFacts | null {
  const count = captures.filter((c) => c[role] === who).length;
  let run = 0;
  for (let i = captures.length - 1; i >= 0 && captures[i][role] === who; i--) run++;
  if (count < CHAT_LIMITS.streakSize && run < CHAT_LIMITS.consecutiveStreakSize) return null;
  return { count, consecutive: run === count };
}

export interface ChatSituation {
  version: number;
  events: readonly GameEvent[];
  /** Estado de la partida en esa versión. */
  state: GameState;
  /** Mensajes ya publicados en la partida. */
  messageCount: number;
  director: DirectorState;
}

export const initialDirectorState = (): DirectorState => ({
  lastMessageVersion: null,
  lastSpokeAt: {},
  captures: [],
  recent: [],
  usedLines: {},
  usedCatchphrases: {},
});

const RELEVANT_EVENTS = new Set<GameEvent["type"]>([
  "piece_captured",
  "third_six_penalty",
  "player_finished",
  "piece_reached_goal",
  "game_finished",
]);

/**
 * Filtro previo (sin leer la BD): la versión tiene algún acontecimiento relevante o toca valorar un
 * comentario de ambiente. Las tiradas y los movimientos normales no generan mensajes.
 */
export function isChatCandidate(events: readonly GameEvent[], version: number): boolean {
  return events.some((e) => RELEVANT_EVENTS.has(e.type)) || version % CHAT_LIMITS.ambientCheckEvery === 0;
}

const talk = (id: PlayerId) => getCharacter(id)?.chat.talkativeness ?? 0.5;

/** Elige uno al azar con pesos > 0; `null` si no hay ninguno. */
function pick<T>(items: readonly T[], weight: (item: T) => number, random: Random): T | null {
  const weighted = items.map((item) => ({ item, w: Math.max(0, weight(item)) })).filter((x) => x.w > 0);
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  if (total <= 0) return null;
  let r = clamp01(random()) * total;
  for (const x of weighted) {
    if ((r -= x.w) < 0) return x.item;
  }
  return weighted[weighted.length - 1].item;
}

const clamp01 = (r: number) => (Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999_999) : 0);
const chance = (p: number, random: Random) => clamp01(random()) < p;

export interface Candidate {
  speaker: PlayerId;
  kind: ChatLineKind;
  rival: PlayerId | null;
  weight: number;
  /** Datos de racha para la frase principal. */
  streak?: StreakFacts;
  /** Réplica posible: quién y con qué tipo. */
  reply?: { speaker: PlayerId; kind: ChatLineKind; rival: PlayerId | null };
}

/**
 * Plan de la versión: 0, 1 o 2 intervenciones (mensaje y, como mucho, una réplica), y el estado del
 * director con las capturas recientes actualizadas. Los tiempos de habla los actualiza
 * `recordPublished` con lo que se publique de verdad.
 */
export function planChat(situation: ChatSituation, random: Random): { utterances: Utterance[]; director: DirectorState } {
  const { version, events, state } = situation;
  const director = trackCaptures(situation.director, version, events);
  const players = state.players.map((p) => p.id);
  const others = (id: PlayerId) => players.filter((p) => p !== id);
  const budget = CHAT_LIMITS.maxMessagesPerGame - situation.messageCount;
  const done = (utterances: Utterance[]) => ({ utterances, director });

  // ── Victoria: el primero en terminar. Siempre habla y se salta las pausas. ──
  const victory = events.find((e): e is Extract<GameEvent, { type: "player_finished" }> => e.type === "player_finished" && e.place === 1);
  if (victory) {
    if (budget <= 0) return done([]);
    const winner = victory.playerId;
    const utterances: Utterance[] = [
      { speaker: winner, kind: "victory_win", trigger: "victory", rival: null, replyTo: null, important: true },
    ];
    const replier = pick(others(winner), talk, random);
    if (replier && budget >= 2 && chance(REPLY_CHANCE * talk(replier), random)) {
      utterances.push({ speaker: replier, kind: "victory_reply", trigger: "victory", rival: winner, replyTo: 0, important: true });
    }
    return done(utterances);
  }

  // Mientras nadie ha ganado, se reservan mensajes para la victoria.
  const reserve = state.ranking.length === 0 ? CHAT_LIMITS.victoryReserve : 0;
  const available = budget - reserve;
  if (available <= 0) return done([]);

  // Última versión (fin de la partida): el último comentario se salta las pausas.
  const bypass = events.some((e) => e.type === "game_finished");
  const sinceLast = director.lastMessageVersion === null ? Infinity : version - director.lastMessageVersion;
  if (!bypass && sinceLast < CHAT_LIMITS.globalCooldown) return done([]);
  const rested = (id: PlayerId) => {
    const last = director.lastSpokeAt[id];
    return bypass || last === undefined || version - last >= CHAT_LIMITS.characterCooldown;
  };

  const choose = (trigger: ChatTrigger, triggerChance: number, candidates: Candidate[], important: boolean) => {
    const main = pick(candidates.filter((c) => rested(c.speaker)), (c) => c.weight, random);
    if (!main || !chance(triggerChance * talk(main.speaker), random)) return null;
    const utterances: Utterance[] = [
      { speaker: main.speaker, kind: main.kind, trigger, rival: main.rival, replyTo: null, important, ...(main.streak ? { streak: main.streak } : {}) },
    ];
    const reply = main.reply;
    if (
      reply &&
      reply.speaker !== main.speaker &&
      available >= 2 &&
      rested(reply.speaker) &&
      chance(REPLY_CHANCE * talk(reply.speaker), random)
    ) {
      utterances.push({ speaker: reply.speaker, kind: reply.kind, trigger, rival: reply.rival, replyTo: 0, important });
    }
    return utterances;
  };

  // ── Tercer seis ──
  const penalty = events.find((e) => e.type === "third_six_penalty");
  if (penalty) {
    const victim = penalty.playerId;
    const teaser = pick(others(victim), talk, random);
    const candidates: Candidate[] = [
      {
        speaker: victim,
        kind: "third_six_self",
        rival: null,
        weight: talk(victim),
        reply: teaser ? { speaker: teaser, kind: "third_six_tease", rival: victim } : undefined,
      },
    ];
    if (teaser) {
      candidates.push({
        speaker: teaser,
        kind: "third_six_tease",
        rival: victim,
        weight: talk(teaser) * 0.6,
        reply: { speaker: victim, kind: "third_six_self", rival: null },
      });
    }
    const plan = choose("third_six", TRIGGER_CHANCE.thirdSix, candidates, false);
    if (plan) return done(plan);
  }

  // ── Capturas y rachas ──
  const capture = events.find((e) => e.type === "piece_captured");
  if (capture) {
    const by = capture.playerId;
    const victim = capture.victimId;
    const boast: Candidate = {
      speaker: by,
      kind: "capture_boast",
      rival: victim,
      weight: talk(by),
      reply: { speaker: victim, kind: "capture_lament", rival: by },
    };
    const lament: Candidate = {
      speaker: victim,
      kind: "capture_lament",
      rival: by,
      weight: talk(victim) * 0.8,
      reply: { speaker: by, kind: "capture_boast", rival: victim },
    };
    // `director.captures` ya incluye esta captura (trackCaptures).
    const hunting = streakOf(director.captures, by, "by");
    const hunted = streakOf(director.captures, victim, "victim");
    if (hunting) {
      const plan = choose("capture_streak", TRIGGER_CHANCE.captureStreak, [{ ...boast, kind: "streak_boast", streak: hunting }], true);
      if (plan) return done(plan);
    } else if (hunted) {
      const plan = choose("bad_streak", TRIGGER_CHANCE.badStreak, [{ ...lament, kind: "streak_lament", weight: 1, streak: hunted }], true);
      if (plan) return done(plan);
    }
    const plan = choose("capture", TRIGGER_CHANCE.capture, [boast, lament], true);
    if (plan) return done(plan);
  }

  // ── Puesto final (2.º, 3.º…) ──
  const finished = events.find((e) => e.type === "player_finished");
  if (finished) {
    const plan = choose("finish_place", TRIGGER_CHANCE.finishPlace, [
      { speaker: finished.playerId, kind: "finish_place", rival: null, weight: 1 },
    ], false);
    if (plan) return done(plan);
  }

  // ── Ficha en meta ──
  const goal = events.find((e) => e.type === "piece_reached_goal");
  if (goal) {
    const plan = choose("goal", TRIGGER_CHANCE.goal, [{ speaker: goal.playerId, kind: "goal", rival: null, weight: 1 }], false);
    if (plan) return done(plan);
  }

  // ── Ambiente tras un silencio largo ──
  if (
    !bypass &&
    version % CHAT_LIMITS.ambientCheckEvery === 0 &&
    (director.lastMessageVersion === null ? version : sinceLast) >= CHAT_LIMITS.silenceVersions
  ) {
    const candidates = ambientCandidates(state);
    const plan = choose("ambient", TRIGGER_CHANCE.ambient, candidates, false);
    if (plan) return done(plan);
  }

  return done([]);
}

/**
 * Candidatos del comentario de ambiente. La clasificación usa el progreso real y es independiente del
 * orden de los jugadores (un empate no favorece a nadie):
 * - Primero en solitario (progreso estrictamente mayor que el de todos): `ambient_lead`, el único tipo
 *   que puede afirmar que va ganando. Su rival, si lo nombra, es el último en solitario. Solo mientras
 *   nadie ha terminado: después de la primera victoria, el primero entre los que quedan usa
 *   `ambient_ahead` (neutral), porque las frases de liderazgo hablan de la partida entera.
 * - Los demás pueden decir algo neutral de progreso (`ambient_ahead`, que no afirma posición; su rival,
 *   si lo nombra, es el último en solitario) o, si alguien va por delante de ellos, que van por detrás
 *   (`ambient_behind`, «voy perdiendo»; su rival, si lo nombra, es el primero en solitario).
 * - Con un empate en cabeza nadie lidera; con todos empatados solo hay frases neutrales.
 * La frecuencia no cambia: el peso total de cada personaje es su `talkativeness`, repartido entre los
 * tipos que puede usar. Solo cuentan quienes siguen jugando.
 */
export function ambientCandidates(state: GameState): Candidate[] {
  const players = getPlayerSummaries(state).filter((s) => !state.ranking.includes(s.id));
  if (players.length === 0) return [];
  const max = Math.max(...players.map((p) => p.progress));
  const min = Math.min(...players.map((p) => p.progress));
  const atMax = players.filter((p) => p.progress === max);
  const atMin = players.filter((p) => p.progress === min);
  const soleLeader = players.length > 1 && atMax.length === 1 ? atMax[0].id : null;
  const soleLast = players.length > 1 && atMin.length === 1 && max !== min ? atMin[0].id : null;
  // Tras la primera victoria la partida sigue (por los demás puestos), pero ya nadie «va ganando» la
  // partida: las frases de liderazgo hablan de la partida entera. El primero entre los que quedan usa
  // frases neutrales (`ambient_ahead`), con el último en solitario como rival si lo hay.
  const someoneFinished = state.ranking.length > 0;

  return players.flatMap(({ id, progress }): Candidate[] => {
    if (id === soleLeader) {
      const kind = someoneFinished ? "ambient_ahead" : "ambient_lead";
      return [{ speaker: id, kind, rival: soleLast, weight: talk(id) }];
    }
    const kinds: Pick<Candidate, "kind" | "rival">[] = [{ kind: "ambient_ahead", rival: soleLast !== id ? soleLast : null }];
    if (progress < max) kinds.push({ kind: "ambient_behind", rival: soleLeader });
    return kinds.map((k) => ({ speaker: id, ...k, weight: talk(id) / kinds.length }));
  });
}

/**
 * Añade las capturas de la versión y olvida las que salen de la ventana de rachas. También sirve
 * para "observar" una versión sin hablar (versiones desfasadas al recuperar la cola).
 */
export function trackCaptures(director: DirectorState, version: number, events: readonly GameEvent[]): DirectorState {
  const fresh = events
    .filter((e) => e.type === "piece_captured")
    .map((e) => ({ v: version, by: e.playerId, victim: e.victimId }));
  const captures = [...director.captures, ...fresh].filter((c) => version - c.v < CHAT_LIMITS.streakWindow).slice(-CHAT_LIMITS.maxTrackedCaptures);
  return fresh.length === 0 && captures.length === director.captures.length ? director : { ...director, captures };
}

/**
 * Registra lo publicado de verdad: tiempos de habla, textos recientes, las frases usadas por cada
 * personaje (`lineId`, si el escritor lo indica; el de un LLM no lo tendrá) y las coletillas que ha
 * publicado (`usedCatchphrases`, de cualquier escritor). Se guarda con `chat_commit`, en la misma
 * transacción que los mensajes.
 */
export function recordPublished(
  director: DirectorState,
  version: number,
  published: readonly { speaker: PlayerId; text: string; lineId?: string }[],
): DirectorState {
  if (published.length === 0) return director;
  const lastSpokeAt = { ...director.lastSpokeAt };
  const usedLines = { ...director.usedLines };
  const usedCatchphrases = { ...director.usedCatchphrases };
  for (const p of published) {
    lastSpokeAt[p.speaker] = version;
    // Coletillas de quien habla en el texto publicado (del LLM o local). Solo lo publicado de verdad:
    // las respuestas rechazadas nunca llegan aquí.
    const detected = detectCatchphrases(p.speaker, p.text);
    if (detected.length > 0) {
      usedCatchphrases[p.speaker] = addCatchphrases(usedCatchphrases[p.speaker] ?? [], detected, CHAT_LIMITS.usedCatchphrasesPerCharacter);
    }
    if (p.lineId) {
      const previous = (usedLines[p.speaker] ?? []).filter((id) => id !== p.lineId);
      usedLines[p.speaker] = [...previous, p.lineId].slice(-CHAT_LIMITS.usedLinesPerCharacter);
    }
  }
  return {
    ...director,
    lastMessageVersion: version,
    lastSpokeAt,
    usedLines,
    usedCatchphrases,
    recent: [...director.recent, ...published.map((p) => ({ speaker: p.speaker, text: p.text }))].slice(-CHAT_LIMITS.recentTexts),
  };
}
