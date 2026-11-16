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
/** Objeto que cambia el sentido: «estoy perdiendo la paciencia», «voy ganando tiempo». */
const NOT_OBJECT = String.raw`(?!\s+(?:la|el|los|las|lo|mi|mis|tu|tus|su|sus|un|una|tiempo|turnos?|fichas?|paciencia|terreno|confianza)(?![\p{L}]))`;

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
type StandingRequest = Pick<ChatWriteRequest, "utterance" | "leader" | "last">;

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
