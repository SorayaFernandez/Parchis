// Prompt del selector estratégico (puro). El modelo recibe quién decide, su personalidad y su perfil
// estratégico (en palabras, a partir de los multiplicadores reales de `characters.ts`), el estado
// relevante (lo que se juega, la obligación del motor y el progreso de cada jugador) y SOLO las opciones
// legales con sus hechos simulados. Nunca la recomendación ni la puntuación de la estrategia local
// (`chooseMove`/`scoreMove`), ni la ficha interna (`pieceIndex`): solo los identificadores A, B, C…

import type { GameState, PlayerId } from "@/lib/engine";
import { getCharacter, getStrategy, type StrategyCriterion, type StrategyProfile } from "@/lib/game/characters";
import { getPlayerSummaries } from "@/lib/hud/summary";
import type { MoveDecision, MoveFacts, PositionFact } from "./options";

export interface MovePromptMessage {
  role: "system" | "user";
  content: string;
}

/** Qué significa cada criterio del perfil para quien juega. */
const CRITERIA: Readonly<Record<StrategyCriterion, string>> = {
  capture: "capturar fichas rivales",
  reachGoal: "llevar fichas a la meta",
  leaveBase: "sacar fichas de casa",
  enterFinalStretch: "meter fichas en el pasillo final",
  landOnSafeCell: "dejar las fichas en casillas seguras",
  progressPerStep: "avanzar cuantas más casillas mejor",
  threatPerEnemy: "no dejar fichas a tiro de los rivales",
  blockade: "formar barreras con tus fichas",
  huntPerTarget: "acercarse a fichas rivales para cazarlas",
};

/** «a, b y c». */
const list = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`);

/** Perfil estratégico en palabras: lo que más le importa y lo que menos (multiplicadores ≠ 1). */
export function describeStrategy(strategy: StrategyProfile): string {
  const entries = Object.entries(strategy.multipliers) as [StrategyCriterion, number][];
  const much = entries.filter(([, m]) => m >= 1.5).map(([c]) => CRITERIA[c]);
  const more = entries.filter(([, m]) => m > 1 && m < 1.5).map(([c]) => CRITERIA[c]);
  const less = entries.filter(([, m]) => m > 0 && m < 1).map(([c]) => CRITERIA[c]);
  const none = entries.filter(([, m]) => m === 0).map(([c]) => CRITERIA[c]);
  const parts = [
    much.length > 0 ? `Te importa mucho ${list(much)}.` : "",
    more.length > 0 ? `Te importa bastante ${list(more)}.` : "",
    less.length > 0 ? `Te importa poco ${list(less)}.` : "",
    none.length > 0 ? `No te importa ${list(none)}.` : "",
    strategy.randomness > 0 ? "De vez en cuando eliges una jugada distinta de la más evidente." : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Juegas equilibrado, sin preferencias especiales.";
}

const nameOf = (id: PlayerId) => getCharacter(id)?.name ?? id;

function position(p: PositionFact): string {
  switch (p.zone) {
    case "casa":
      return "casa";
    case "recorrido":
      return `recorrido (${p.casillas} de 63 casillas)`;
    case "pasillo":
      return `pasillo final (${p.casilla} de 7)`;
    case "meta":
      return "meta";
  }
}

/** Opción para el modelo: identificador y hechos, sin la ficha interna. */
function optionForModel(id: string, f: MoveFacts) {
  return {
    id,
    desde: position(f.desde),
    hasta: position(f.hasta),
    avance: f.avance,
    saleDeCasa: f.saleDeCasa,
    captura: f.captura ? nameOf(f.captura.jugador) : null,
    llegaAMeta: f.llegaAMeta,
    entraEnPasillo: f.entraEnPasillo,
    casillaSegura: f.casillaSegura,
    formaBarrera: f.formaBarrera,
    rompeBarrera: f.rompeBarrera,
    amenazas: f.amenazas,
    presas: f.presas,
    bonusGanado: f.bonusGanado ? `+${f.bonusGanado.cantidad} por ${f.bonusGanado.motivo === "capture" ? "captura" : "meta"}` : null,
    repiteTirada: f.repiteTirada,
  };
}

/**
 * Mensajes para el modelo. La respuesta pedida es exclusivamente `{"choice":"<id>"}` con uno de los
 * identificadores de `decision.options` (ver `parse.ts`).
 */
export function buildMovePrompt(state: GameState, decision: MoveDecision): MovePromptMessage[] {
  const character = getCharacter(decision.playerId);
  const name = character?.name ?? decision.playerId;
  const ids = decision.options.map((o) => o.id);

  const system = [
    `Eres ${name} y juegas una partida de parchís contra otros tres. Te toca mover y tienes que elegir qué ficha mueves.`,
    character ? `Tu forma de jugar: ${character.title.toLowerCase()}. ${describeStrategy(getStrategy(decision.playerId))}` : describeStrategy(getStrategy(decision.playerId)),
    "Reglas de la respuesta:",
    `- Elige exactamente una de las opciones legales: ${ids.join(", ")}. No hay otras jugadas posibles.`,
    // El formato se muestra con un marcador, nunca con un identificador real (un ejemplo con «A»
    // inclinaría al modelo hacia la primera opción).
    '- Responde solo con un objeto JSON con este formato: {"choice":"<identificador>"}, poniendo en lugar de <identificador> la letra de la opción elegida, sin texto, explicaciones ni Markdown.',
    "- Elige la opción que mejor encaje con tu forma de jugar y con la situación.",
    "Significado de los datos: «amenazas» son las fichas rivales que podrían comerte esa ficha en su próxima tirada; «presas», las fichas rivales que esa ficha podría comer en tu siguiente tirada; «avance», las casillas que avanza. Las capturas, la meta, las barreras y los bonus son los que se producen al hacer ese movimiento.",
  ].join("\n");

  const players = getPlayerSummaries(state).map((p) => ({
    nombre: nameOf(p.id),
    ...(p.id === decision.playerId ? { tu: true } : {}),
    enCasa: p.pieces.base,
    enRecorrido: p.pieces.track,
    enPasillo: p.pieces.final,
    enMeta: p.pieces.finished,
    progreso: p.progress,
    ...(p.place !== null ? { puesto: p.place } : {}),
  }));

  const situation = {
    jugada:
      decision.source.tipo === "dado"
        ? { tipo: "dado", valor: decision.source.valor }
        : { tipo: "bonus", casillas: decision.source.cantidad, motivo: decision.source.motivo === "capture" ? "captura" : "meta" },
    obligacion: decision.obligation,
    jugadores: players,
    opciones: decision.options.map((o) => optionForModel(o.id, o.facts)),
  };

  return [
    { role: "system", content: system },
    { role: "user", content: `Situación (JSON):\n${JSON.stringify(situation)}\nTu respuesta (solo el JSON):` },
  ];
}
