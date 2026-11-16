// Afirmaciones sobre quién va ganando o perdiendo, comprobadas con la clasificación real de la partida.
//
// La clasificación no la decide el modelo: la calcula el procesador del chat en el servidor con el estado
// validado de esa versión (`gameLeader` y `gameLast` en `director.ts`, por el progreso real de cada jugador)
// y llega en la petición como `leader` y `last`. La usan los dos escritores: el validador de Nemotron
// (`checkGameTalk` en `llm/quality.ts`) y el escritor local (`createLocalWriter`), que descarta las frases
// del catálogo que afirmarían una posición falsa. Así también la demostración, que usa el mismo procesador.
//
// Reglas:
// - «Voy ganando» y equivalentes («estoy ganando», «sigo ganando», «encabezo la partida», «estoy
//   liderando»): solo si quien habla es `leader`.
// - «Voy perdiendo» y equivalentes («estoy perdiendo», «voy por detrás», «me he quedado atrás»): solo si
//   quien habla es `last`.
// - Lo mismo dicho del rival («vas ganando», «va perdiendo», «te has quedado muy atrás», «vas muy atrás»),
//   con la posición del rival. En tercera persona («va…») el sujeto es el rival, salvo «la abuela va…»
//   dicho por Abuela Pilar.
// - Con un empate (`leader`/`last` = null), sin estado válido (`undefined`), en plural («vamos ganando») o
//   en negativo («no voy ganando»), no se puede afirmar: se rechaza.
// «Por detrás de alguien» es relativo y no se comprueba aquí (lo rechaza siempre `STATE_CLAIMS`). Las demás
// afirmaciones de posición («voy primero», «en cabeza», «voy delante», «el último», «a la cola») siguen
// rechazadas siempre por `STATE_CLAIMS`.

import type { PlayerId } from "@/lib/engine";
import { CHARACTER_NAMES } from "@/lib/game/characters";
import { normalizeText } from "./catchphrases";
import type { ChatWriteRequest } from "./writer";

export type PositionKind = "lead" | "last";
type Subject = "self" | "rival" | "group";

export interface PositionClaim {
  /** El texto que se ha reconocido como afirmación (normalizado). */
  term: string;
  kind: PositionKind;
  subject: Subject;
  negated: boolean;
}

const PILAR = "ai-green";
const ADVERB = String.raw`(?:(?:ya|todavia|aun|de\s+momento|claramente)\s+)?`;
/**
 * Objeto que cambia el sentido: «estoy perdiendo la paciencia», «voy ganando tiempo». «la partida» no cuenta
 * como tal objeto: «voy ganando la partida» y «vas perdiendo la partida» son afirmaciones de posición.
 */
const NOT_OBJECT = String.raw`(?!\s+(?:la(?!\s+partida(?![\p{L}]))|el|los|las|lo|mi|mis|tu|tus|su|sus|un|una|tiempo|turnos?|fichas?|paciencia|terreno|confianza)(?![\p{L}]))`;

const VERBS: Readonly<Record<Subject | "third", string>> = {
  self: "voy|estoy|sigo",
  rival: "vas|estas|sigues",
  third: "va|esta|sigue",
  group: "vamos|vais|van|estamos|estais|estan|seguimos|seguis|siguen",
};
const PERSON_OF: ReadonlyArray<[RegExp, Subject | "third"]> = (Object.entries(VERBS) as [Subject | "third", string][]).map(
  ([subject, verbs]) => [new RegExp(`^(?:${verbs})$`, "u"), subject],
);

/** «voy ganando», «estás perdiendo», «sigue por detrás» (sin «de»: «por detrás de ti» es relativo). */
const VERB_CLAIM = new RegExp(
  String.raw`(?<![\p{L}])(${Object.values(VERBS).join("|")})\s+${ADVERB}(ganando|liderando|perdiendo|por\s+detras(?!\s+de(?![\p{L}])))(?![\p{L}])${NOT_OBJECT}`,
  "gu",
);
/** «encabezo la partida», «lideras»: el verbo ya lleva la persona. */
const LEAD_VERB = /(?<![\p{L}])(encabezo|lidero|encabezas|lideras|encabeza|lidera|encabezamos|lideramos|encabezais|liderais|encabezan|lideran)(?![\p{L}])/gu;
const LEAD_VERB_PERSON: Readonly<Record<string, Subject | "third">> = {
  encabezo: "self", lidero: "self", encabezas: "rival", lideras: "rival", encabeza: "third", lidera: "third",
  encabezamos: "group", lideramos: "group", encabezais: "group", liderais: "group", encabezan: "group", lideran: "group",
};
/** Quedarse atrás o ir muy atrás: «me he quedado atrás», «te estás quedando atrás», «vas muy atrás». */
const BEHIND = new RegExp(
  String.raw`(?<![\p{L}])(?:(me|te|se|nos|os)\s+(?:(?:he|has|ha|hemos|habeis|han|estoy|estas|esta|estamos|estais|estan)\s+)?(?:quedad[oa]s?|quedando)|(voy|vas|va|vamos|vais|van))\s+(?:muy\s+|bastante\s+|tan\s+)?atras(?![\p{L}])`,
  "gu",
);
const BEHIND_PERSON: Readonly<Record<string, Subject | "third">> = {
  me: "self", voy: "self", te: "rival", vas: "rival", se: "third", va: "third", nos: "group", os: "group", vamos: "group", vais: "group", van: "group",
};
/** Negación justo antes («no voy ganando», «todavía no vas perdiendo», «no te has quedado atrás»). */
const NEGATED_BEFORE = /(?<![\p{L}])(?:no|nunca|jamas)\s+(?:(?:me|te|se|nos|os|lo|la|le)\s+)?$/u;

function subjectOf(person: Subject | "third", before: string, speaker: string): Subject {
  if (person !== "third") return person;
  // «La abuela va ganando» dicho por Abuela Pilar habla de ella misma.
  return speaker === PILAR && /(?<![\p{L}])la\s+abuela\s+$/u.test(before) ? "self" : "rival";
}

/** Afirmaciones de posición del texto, con su tipo, su sujeto y si van negadas. */
export function positionClaims(text: string, speaker: string): PositionClaim[] {
  const t = normalizeText(text);
  const claims: PositionClaim[] = [];
  const push = (index: number, term: string, kind: PositionKind, person: Subject | "third") => {
    const before = t.slice(0, index);
    claims.push({ term: term.replace(/\s+/g, " "), kind, subject: subjectOf(person, before, speaker), negated: NEGATED_BEFORE.test(before) });
  };
  for (const m of t.matchAll(VERB_CLAIM)) {
    const person = PERSON_OF.find(([re]) => re.test(m[1]))![1];
    push(m.index ?? 0, m[0], /^(?:ganando|liderando)$/u.test(m[2]) ? "lead" : "last", person);
  }
  for (const m of t.matchAll(LEAD_VERB)) push(m.index ?? 0, m[0], "lead", LEAD_VERB_PERSON[m[1]]);
  for (const m of t.matchAll(BEHIND)) push(m.index ?? 0, m[0], "last", BEHIND_PERSON[m[1] ?? m[2]]);
  return claims;
}

/** Datos de la clasificación que necesita la comprobación (los de `ChatWriteRequest`). */
type StandingRequest = Pick<ChatWriteRequest, "utterance" | "leader" | "last" | "winner">;

/**
 * La primera afirmación de posición que la clasificación real no respalda (con su texto), o `null` si no
 * hay ninguna o todas son ciertas.
 */
export function unbackedPositionClaim(text: string, request: StandingRequest): string | null {
  const { speaker, rival } = request.utterance;
  for (const claim of positionClaims(text, speaker)) {
    if (claim.negated || claim.subject === "group") return claim.term;
    const who: PlayerId | null = claim.subject === "self" ? speaker : rival;
    const holder = claim.kind === "lead" ? request.leader : request.last;
    if (!who || !holder || holder !== who) return claim.term;
  }
  return null;
}

// ── Afirmar que un rival gana la partida ─────────────────────────────────────────────────────────────
//
// «No me extraña que Brava gane», «no me extraña que ganes», «Brava va a ganar», «eres la ganadora»: solo son
// ciertas si ese rival ya ha ganado (`winner`, de `state.ranking[0]`) o en la réplica a su victoria
// (`victory_reply`, cuyo rival es siempre el ganador). Si todavía no ha ganado nadie, o ganó otro, se rechazan.
// No cuentan los deseos ni las hipótesis («ojalá gane», «si ganas», «a ver si gana»), «que gane el mejor» (sin
// el rival como sujeto), ni «ganar» con otro objeto («gana terreno», «gana una ficha», «me da la gana»).
// La victoria propia («he ganado») la sigue comprobando `RESULT_CLAIM` (solo en la victoria).

/** Nombres y alias de cada personaje, sin tildes y en minúsculas. */
const NAME_FORMS: Readonly<Record<string, readonly string[]>> = {
  "ai-pink": ["brava"],
  "ai-purple": ["don ernesto", "ernesto"],
  "ai-green": ["abuela pilar", "pilar", "la abuela", "abuela"],
  "ai-blue": ["chispa"],
};
const WIN_OBJECT = String.raw`(?!\s+(?:terreno|tiempo|ventaja|confianza|casillas?|fichas?|turnos?|un|una|uno|el|los|las|mi|mis|tu|tus|su|sus|algo|nada|la(?!\s+partida)))`;
/** Segunda persona: el sujeto es el rival al que se habla. */
const WIN_YOU = new RegExp(String.raw`(?<![\p{L}])(ganes|ganaras|ganarias|vas\s+a\s+ganar|vayas\s+a\s+ganar|eres\s+(?:el|la)\s+ganador(?:a)?)(?![\p{L}])${WIN_OBJECT}`, "gu");
/** Tercera persona tras «(no) me extraña que…», «normal que…», «lógico que…»: el sujeto es el rival. */
const WIN_FACTIVE = new RegExp(
  String.raw`(?<![\p{L}])(?:extra[ñn]a|extra[ñn]o|sorprende|normal|logico|claro)\s+que\s+(?:(?:\p{L}+\s+){0,2})?(gane|gana|ganara|vaya\s+a\s+ganar)(?![\p{L}])${WIN_OBJECT}`,
  "gu",
);
const WIN_THIRD = String.raw`(gane|gana|ganara|ganaria|va\s+a\s+ganar|vaya\s+a\s+ganar|es\s+(?:el|la)\s+ganador(?:a)?)`;
const HYPOTHESIS_BEFORE = /(?<![\p{L}])(?:ojala|a\s+ver\s+si|si|cuando|como|quiza|quizas|tal\s+vez|puede\s+que|que\s+no)\s+(?:\p{L}+\s+)?$/u;

/** Quién ha ganado de verdad, según la petición: `winner` o, en la réplica a una victoria, su rival. */
function realWinner(request: StandingRequest): PlayerId | null {
  if (request.utterance.trigger === "victory" && request.utterance.kind === "victory_reply") return request.utterance.rival;
  return request.winner ?? null;
}

/**
 * La primera afirmación de que un rival gana la partida que los datos reales no respaldan, o `null`. Solo
 * se refiere al rival de la intervención (los demás nombres ya los rechaza el validador).
 */
export function unbackedWinClaim(text: string, request: StandingRequest): string | null {
  const t = normalizeText(text);
  const { rival } = request.utterance;
  const claims: { index: number; term: string }[] = [];
  for (const m of t.matchAll(WIN_YOU)) claims.push({ index: m.index ?? 0, term: m[0] });
  for (const m of t.matchAll(WIN_FACTIVE)) claims.push({ index: m.index ?? 0, term: m[0] });
  if (rival) {
    for (const name of NAME_FORMS[rival] ?? [normalizeText(CHARACTER_NAMES[rival] ?? "")]) {
      const words = name.split(/\s+/).join("\\s+");
      const re = new RegExp(String.raw`(?<![\p{L}])${words}\s+(?:(?:ya|seguro|claro|tambien|siempre)\s+)?${WIN_THIRD}(?![\p{L}])${WIN_OBJECT}`, "gu");
      for (const m of t.matchAll(re)) claims.push({ index: m.index ?? 0, term: m[0] });
    }
  }
  const winner = realWinner(request);
  for (const claim of claims.sort((a, b) => a.index - b.index)) {
    if (HYPOTHESIS_BEFORE.test(t.slice(0, claim.index))) continue;
    if (!rival || winner !== rival) return claim.term.replace(/\s+/g, " ");
  }
  return null;
}
