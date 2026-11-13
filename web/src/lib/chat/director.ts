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
   * Racha del propio mensaje principal de una racha (`streak_boast`: las capturas de quien habla;
   * `streak_lament`: las que ha recibido): capturas en la ventana y si fueron todas seguidas (ninguna
   * otra captura entre medias). Las frases locales la usan con `{count}` y `{ritmo}` (solo en los tipos
   * de racha), así que nunca dicen "dos" si fueron tres, ni "seguidas" si no lo fueron. Las réplicas
   * NO la llevan: su contexto, desde su propio punto de vista, va en `captures`.
   */
  streak?: StreakFacts;
  /**
   * Hechos reales de la captura de esta versión vistos desde quien habla (mensajes y réplicas de
   * captura y de racha): sus recuentos, los del rival, los de la pareja en cada dirección y el estado
   * de la racha y la mala racha de cada uno. Los usan el prompt y el validador de cifras y de rachas.
   */
  captures?: CaptureFacts;
}

/** Un recuento real de capturas en la ventana: cuántas y si fueron todas seguidas (sin otra entre medias). */
export interface StreakFacts {
  count: number;
  consecutive: boolean;
}

/**
 * Estado de una racha (capturas hechas) o de una mala racha (capturas recibidas) en esta versión:
 * - `active`: existe después de esta captura (es la que acaba de crecer, o sigue).
 * - `ended`: existía y seguía viva justo antes, y esta captura la acaba de interrumpir. Los datos son los
 *   de la racha interrumpida (antes de la captura).
 */
export interface StreakState extends StreakFacts {
  status: "active" | "ended";
}

/** Recuentos y rachas de un participante (en la ventana de rachas del director). */
export interface PlayerCaptureFacts {
  /** Capturas que ha hecho (a cualquiera) en la ventana, incluida la de esta versión: recuento histórico. */
  made: StreakFacts;
  /** Capturas que ha recibido (de cualquiera) en la ventana, incluida la de esta versión. */
  received: StreakFacts;
  /**
   * Capturas que ha hecho desde la última vez que le capturaron (el tramo vivo de su racha), en la
   * ventana. Igual que `made` si no le han capturado en la ventana.
   */
  madeSinceBreak: StreakFacts;
  /** Capturas que ha recibido desde la última vez que capturó él (el tramo vivo de su mala racha). */
  receivedSinceBreak: StreakFacts;
  /** Racha de capturas (solo el tramo vivo): activa, recién interrumpida o ninguna. */
  streak: StreakState | null;
  /** Mala racha (solo el tramo vivo): activa, recién interrumpida o ninguna. */
  badStreak: StreakState | null;
}

/**
 * Hechos de captura vistos desde quien habla. Con el historial incompleto (`historyComplete`) solo se sabe
 * la captura de esta versión (quién la hace y quién la recibe): ni recuentos ni rachas.
 */
export type CaptureFacts = CompleteCaptureFacts | IncompleteCaptureFacts;

export interface IncompleteCaptureFacts {
  history: "incomplete";
  /** Papel de quien habla en la captura de esta versión: la hace (`by`) o la recibe (`victim`). */
  selfRole: "by" | "victim";
}

/** Hechos de captura vistos desde quien habla (`self`) frente a su rival (`rival`), con el historial completo. */
export interface CompleteCaptureFacts {
  history: "complete";
  /** Papel de quien habla en la captura de esta versión: la hace (`by`) o la recibe (`victim`). */
  selfRole: "by" | "victim";
  self: PlayerCaptureFacts;
  rival: PlayerCaptureFacts;
  /** Capturas de quien habla AL rival (pareja y dirección). */
  selfOnRival: StreakFacts;
  /** Capturas del rival A quien habla. */
  rivalOnSelf: StreakFacts;
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

/** Recuento de las capturas que cumplen `match`: total y si las últimas de la partida son todas ellas. */
function countOf(captures: CaptureLog, match: (c: CaptureLog[number]) => boolean): StreakFacts {
  const count = captures.filter(match).length;
  let run = 0;
  for (let i = captures.length - 1; i >= 0 && match(captures[i]); i--) run++;
  return { count, consecutive: count > 0 && run === count };
}

/**
 * El tramo vivo de `who` en un papel: las capturas posteriores a la última que lo interrumpió. Una racha
 * (`by`) se interrumpe cuando a quien la lleva le capturan; una mala racha (`victim`), cuando quien la
 * sufre captura. Una captura posterior a una interrupción empieza un tramo nuevo: no recupera las
 * capturas del tramo anterior, aunque sigan dentro de la ventana.
 */
function liveSegment(captures: CaptureLog, who: PlayerId, role: "by" | "victim"): CaptureLog {
  const breaker = captures.findLastIndex((c) => (role === "by" ? c.victim : c.by) === who);
  return captures.slice(breaker + 1);
}

/**
 * Racha (`by`) o mala racha (`victim`) de `who` en su tramo vivo, con la misma condición que `streakOf`
 * (3 en el tramo o 2 seguidas). `null` si el tramo vivo no la forma: una racha ya interrumpida no
 * reaparece por seguir dentro de la ventana, y tampoco se "interrumpe" otra vez.
 */
function liveStreak(captures: CaptureLog, who: PlayerId, role: "by" | "victim"): StreakFacts | null {
  return streakOf(liveSegment(captures, who, role), who, role);
}

/**
 * Hechos reales de la captura `by` → `victim` de la versión `version`, vistos desde `speaker` (que es
 * uno de los dos). `captures` ya incluye la captura de esta versión (`trackCaptures`).
 * - `made` y `received`: recuentos históricos de la ventana (varias capturas en poco tiempo).
 * - `streak` y `badStreak`: SOLO el tramo vivo desde la última interrupción.
 *   - Quien captura: su racha queda activa si su tramo vivo la forma; su mala racha, si seguía viva
 *     justo antes, se interrumpe (`ended`, con los datos de su tramo).
 *   - Quien recibe: su mala racha queda activa si su tramo vivo la forma; su racha de capturas, si
 *     seguía viva justo antes, se interrumpe (`ended`).
 * Los disparadores no cambian (`streakOf` sobre la ventana): tras una interrupción puede haber un
 * `capture_streak` por "varias capturas en poco tiempo" sin una racha activa en estos hechos.
 * Todo sale del historial de capturas observado (eventos reales), nunca del texto de otro mensaje.
 */
export function captureFacts(captures: CaptureLog, version: number, by: PlayerId, victim: PlayerId, speaker: PlayerId): CompleteCaptureFacts {
  const before = captures.filter((c) => c.v !== version);
  const active = (facts: StreakFacts | null): StreakState | null => (facts ? { ...facts, status: "active" } : null);
  const ended = (facts: StreakFacts | null): StreakState | null => (facts ? { ...facts, status: "ended" } : null);
  const player = (id: PlayerId): PlayerCaptureFacts => ({
    made: countOf(captures, (c) => c.by === id),
    received: countOf(captures, (c) => c.victim === id),
    madeSinceBreak: countOf(liveSegment(captures, id, "by"), (c) => c.by === id),
    receivedSinceBreak: countOf(liveSegment(captures, id, "victim"), (c) => c.victim === id),
    streak: id === by ? active(liveStreak(captures, id, "by")) : ended(liveStreak(before, id, "by")),
    badStreak: id === victim ? active(liveStreak(captures, id, "victim")) : ended(liveStreak(before, id, "victim")),
  });
  const rival = speaker === by ? victim : by;
  return {
    history: "complete",
    selfRole: speaker === by ? "by" : "victim",
    self: player(speaker),
    rival: player(rival),
    selfOnRival: countOf(captures, (c) => c.by === speaker && c.victim === rival),
    rivalOnSelf: countOf(captures, (c) => c.by === rival && c.victim === speaker),
  };
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
  observedThrough: null,
  historyGapThrough: null,
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
      // La réplica no hereda la racha del mensaje principal (es de otro personaje): en las capturas, su
      // contexto se calcula desde su propio punto de vista (`captures`).
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
    // Cada intervención (mensaje o réplica) recibe los hechos desde el punto de vista de quien habla. Con
    // el historial incompleto, solo el papel de cada uno en esta captura, y sin `streak`: las frases locales
    // con `{count}`/`{ritmo}` se descartan solas y el LLM no recibe cifras. El disparador y el azar no
    // cambian (se decide antes, igual que con el historial completo).
    const complete = historyComplete(director, version);
    const withFacts = (plan: Utterance[]) =>
      plan.map(({ streak, ...u }): Utterance => {
        if (!complete) return { ...u, captures: { history: "incomplete", selfRole: u.speaker === by ? "by" : "victim" } };
        return { ...u, ...(streak ? { streak } : {}), captures: captureFacts(director.captures, version, by, victim, u.speaker) };
      });
    if (hunting) {
      const plan = choose("capture_streak", TRIGGER_CHANCE.captureStreak, [{ ...boast, kind: "streak_boast", streak: hunting }], true);
      if (plan) return done(withFacts(plan));
    } else if (hunted) {
      const plan = choose("bad_streak", TRIGGER_CHANCE.badStreak, [{ ...lament, kind: "streak_lament", weight: 1, streak: hunted }], true);
      if (plan) return done(withFacts(plan));
    }
    const plan = choose("capture", TRIGGER_CHANCE.capture, [boast, lament], true);
    if (plan) return done(withFacts(plan));
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
 * Observa una versión: añade sus capturas, olvida las que salen de la ventana de rachas y lleva el
 * control de continuidad. También sirve para "observar" una versión sin hablar (versiones desfasadas).
 * La llaman todos los caminos del procesador que observan una versión (`planChat`, desfasadas y la
 * victoria en modo mínimo con eventos válidos); las versiones que no llegan aquí (no encoladas o
 * defectuosas) aparecen como un salto en la siguiente.
 * - `observedThrough`: la versión más alta observada; nunca retrocede.
 * - `historyGapThrough`: la última versión no observada o incierta; nunca retrocede. Sube con un salto
 *   (v5 tras v3 → 4), con un estado sin continuidad (sin el campo o reiniciado) que no empieza en v2,
 *   con una versión repetida, anterior o fuera de orden (→ el máximo observado; no añade capturas) y si
 *   el límite de `maxTrackedCaptures` descarta capturas que aún están en la ventana (→ la más reciente
 *   descartada). Ver `historyComplete`.
 */
export function trackCaptures(director: DirectorState, version: number, events: readonly GameEvent[]): DirectorState {
  const observed = director.observedThrough;
  let gap = director.historyGapThrough;
  const uncertainUpTo = (v: number) => {
    if (v >= FIRST_QUEUED_VERSION) gap = gap === null ? v : Math.max(gap, v);
  };
  // Continuidad: cada versión observada debe ser la siguiente a la anterior (la cola empieza en v2).
  const anomaly = observed !== null && version <= observed; // repetida, anterior o fuera de orden
  if (observed === null) {
    if (version > FIRST_QUEUED_VERSION) uncertainUpTo(version - 1); // estado antiguo, reiniciado o sin v2
  } else if (anomaly) {
    uncertainUpTo(observed); // no se sabe qué se ha observado ya: se cuenta de nuevo desde el máximo
  } else if (version > observed + 1) {
    uncertainUpTo(version - 1); // versiones sin observar (no encoladas o defectuosas)
  }
  // Una versión anómala no añade capturas (no se reconstruye ni se duplica nada) y la ventana no retrocede.
  const reference = anomaly ? observed : version;
  const fresh = anomaly
    ? []
    : events.filter((e) => e.type === "piece_captured").map((e) => ({ v: version, by: e.playerId, victim: e.victimId }));
  const inWindow = [...director.captures, ...fresh].filter((c) => reference - c.v < CHAT_LIMITS.streakWindow);
  const kept = inWindow.slice(-CHAT_LIMITS.maxTrackedCaptures);
  // Si el límite de almacenamiento descarta capturas que aún están en la ventana, los recuentos dejan de
  // ser verificables hasta que esas versiones salgan de ella.
  const dropped = inWindow.slice(0, inWindow.length - kept.length);
  if (dropped.length > 0) uncertainUpTo(Math.max(...dropped.map((c) => c.v)));
  return { ...director, captures: kept, observedThrough: Math.max(observed ?? version, version), historyGapThrough: gap };
}

/**
 * Primera versión que llega a la cola del chat: la partida se crea en v1 con un INSERT y el trigger
 * `games_chat_enqueue` solo encola las subidas de versión (cada avance es exactamente `version + 1`).
 */
export const FIRST_QUEUED_VERSION = 2;

/**
 * El historial observado es COMPLETO en `version` si ninguna versión no observada puede afectar a los
 * cálculos. Todos los hechos de captura (`streakOf`, `captureFacts`, rachas, parejas) usan solo las
 * capturas con `version - v < streakWindow` (las que conserva `trackCaptures`), es decir, las versiones
 * `version - 59 … version`. Una versión no observada `g` deja de afectar cuando `version - g ≥ 60`:
 * - hueco en v4: en v63 la ventana es v4…v63 → incompleto; en v64 es v5…v64 → completo;
 * - si llega otro hueco (o una anomalía) antes, `historyGapThrough` sube y la cuenta vuelve a empezar.
 * Al recuperarse solo se usan las capturas observadas que siguen en la ventana; no se reconstruye nada.
 */
export function historyComplete(director: DirectorState, version: number): boolean {
  const gap = director.historyGapThrough;
  return gap === null || version - gap >= CHAT_LIMITS.streakWindow;
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
