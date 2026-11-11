// Catálogo de personajes IA. El `id` es estable: se guarda en el GameState (`players[].id`)
// y no debe cambiar nunca. El nombre visible, la personalidad y la estrategia pueden cambiar
// sin afectar a las partidas guardadas.
//
// La estrategia solo ajusta la puntuación de las jugadas (ver `ai.ts`): la IA elige siempre entre
// los movimientos legales que calcula el motor, así que ninguna personalidad puede saltarse las reglas.

import { COLORS, type Color, type PlayerId } from "@/lib/engine";

/** Criterios que puntúa la heurística (ver `AI_WEIGHTS` en `ai.ts`). */
export type StrategyCriterion =
  | "capture"
  | "reachGoal"
  | "leaveBase"
  | "enterFinalStretch"
  | "landOnSafeCell"
  | "progressPerStep"
  | "threatPerEnemy"
  | "blockade"
  | "huntPerTarget";

/** Multiplicadores sobre `AI_WEIGHTS` (1 = peso base; 0 = no le importa). Siempre ≥ 0. */
export type StrategyMultipliers = Readonly<Record<StrategyCriterion, number>>;

export interface StrategyProfile {
  multipliers: StrategyMultipliers;
  /**
   * Azar acotado: 0 = siempre la mejor jugada (determinista). Con 0.15 elige al azar entre las
   * jugadas legales que puntúan como mucho un 15 % por debajo de la mejor.
   */
  randomness: number;
}

/**
 * Tipos de intervención en el chat. `{rival}` en una frase es el nombre del otro personaje implicado:
 * - victory_win (ganador) / victory_reply ({rival} = ganador)
 * - capture_boast ({rival} = víctima) / capture_lament ({rival} = quien captura)
 * - streak_boast ({rival} = víctima) / streak_lament ({rival} = quien captura); además `{count}`/`{Count}`
 *   (capturas reales de la racha, en palabras) y `{ritmo}` ("seguidas" o "en poco tiempo")
 * - third_six_self / third_six_tease ({rival} = quien sacó los tres seises)
 * - goal, finish_place (sin {rival})
 * - ambient_ahead ({rival} = quien va último) / ambient_behind ({rival} = quien va primero)
 */
export const CHAT_LINE_KINDS = [
  "victory_win",
  "victory_reply",
  "capture_boast",
  "capture_lament",
  "streak_boast",
  "streak_lament",
  "third_six_self",
  "third_six_tease",
  "goal",
  "finish_place",
  "ambient_ahead",
  "ambient_behind",
] as const;
export type ChatLineKind = (typeof CHAT_LINE_KINDS)[number];

/** Tipos cuyas frases pueden usar `{count}`/`{Count}` y `{ritmo}` (datos reales de la racha). */
export const LINE_KINDS_WITH_STREAK: ReadonlySet<ChatLineKind> = new Set(["streak_boast", "streak_lament"]);

/** Tipos cuyas frases nombran a otro personaje con `{rival}`. */
export const LINE_KINDS_WITH_RIVAL: ReadonlySet<ChatLineKind> = new Set([
  "victory_reply",
  "capture_boast",
  "capture_lament",
  "streak_boast",
  "streak_lament",
  "third_six_tease",
  "ambient_ahead",
  "ambient_behind",
]);

export interface ChatProfile {
  /** Registro y tono (referencia para la generación de texto; en 8.2b irá al prompt). */
  register: string;
  /** Ganas de hablar, de 0 a 1: multiplica la probabilidad de intervenir y de replicar. */
  talkativeness: number;
  /** Frases locales por tipo de intervención (también son la reserva si falla un LLM en 8.2b). */
  lines: Readonly<Record<ChatLineKind, readonly string[]>>;
}

export interface Character {
  id: PlayerId;
  /** Nombre visible. */
  name: string;
  /** Color que le asigna `createGame()` por su posición en el catálogo. */
  color: Color;
  /** Arquetipo en pocas palabras. */
  title: string;
  /** Personalidad y forma de hablar. */
  personality: string;
  /** Expresiones habituales (referencia para el futuro LLM; varias aparecen en `chat.lines`). */
  catchphrases: readonly string[];
  strategy: StrategyProfile;
  chat: ChatProfile;
}

/** Perfil neutro: los pesos base, sin azar. Para jugadores que no están en el catálogo. */
export const NEUTRAL_STRATEGY: StrategyProfile = {
  multipliers: {
    capture: 1,
    reachGoal: 1,
    leaveBase: 1,
    enterFinalStretch: 1,
    landOnSafeCell: 1,
    progressPerStep: 1,
    threatPerEnemy: 1,
    blockade: 1,
    huntPerTarget: 1,
  },
  randomness: 0,
};

/** Margen máximo de azar permitido (15 %). */
export const MAX_RANDOMNESS = 0.15;

/**
 * Los cuatro personajes, en el orden en que `createGame()` asigna los colores (COLORS:
 * pink, purple, green, blue). No reordenar: cambiaría el color de cada personaje.
 */
export const CHARACTERS: readonly Character[] = [
  {
    id: "ai-pink",
    name: "Brava",
    color: "pink",
    title: "La agresiva",
    personality:
      "Impulsiva, competitiva y provocadora; se pica enseguida. Frases cortas, exclamaciones y tono de reto.",
    catchphrases: ["¡A casa!", "¿Quién es el siguiente?", "Eso no ha sido nada"],
    strategy: {
      // Cazadora: busca capturas y se acerca a los rivales; arriesga fichas sin miedo.
      multipliers: {
        ...NEUTRAL_STRATEGY.multipliers,
        capture: 1.5,
        leaveBase: 1.25,
        landOnSafeCell: 0.5,
        threatPerEnemy: 0.4,
        huntPerTarget: 3,
      },
      randomness: 0,
    },
    chat: {
      register: "Frases cortas y directas, con exclamaciones. Reta, presume y se pica; nunca insulta.",
      talkativeness: 1,
      lines: {
        victory_win: [
          "¡Primera! ¿Alguien lo dudaba?",
          "¡Gané! Y ni me he despeinado.",
          "¡Eso es! Al podio, por la puerta grande.",
          "¡Victoria! Apuntad cómo se hace.",
          "¡Lo dije desde el principio: esto era mío!",
        ],
        victory_reply: [
          "Disfrútalo, {rival}. La próxima es mía.",
          "Bah, {rival} ha tenido suerte con el dado.",
          "Vale, {rival}. Pero pide la revancha y verás.",
          "¡Felicidades, {rival}! Que te dure poco.",
        ],
        capture_boast: [
          "¡A casa, {rival}!",
          "¿Quién es el siguiente? Ah, eras tú, {rival}.",
          "¡Zas! Vuelta a empezar, {rival}.",
          "Eso por ponerte en mi camino, {rival}.",
          "¡Te vi venir, {rival}! Fuera.",
          "¡Fuera de mi tablero, {rival}!",
          "¡Así se juega! Despídete, {rival}.",
        ],
        capture_lament: [
          "¡Esto no queda así, {rival}!",
          "Disfrútalo mientras puedas, {rival}.",
          "Vale, {rival}. Ahora voy a por ti.",
          "¿A mí? Te acabas de ganar una enemiga, {rival}.",
          "Apúntatelo, {rival}: esta me la cobro.",
          "¡Qué rabia! Ya verás la próxima, {rival}.",
        ],
        streak_boast: [
          "¡Imparable! {rival}, a la cola con los demás.",
          "¡{Count} capturas {ritmo}! Estoy imparable.",
          "¡Ya van {count} {ritmo}! Que alguien me pare.",
          "¡Racha de cazadora! Lo siento, {rival}… no mucho.",
          "{Count} {ritmo} y aún tengo hambre.",
        ],
        streak_lament: [
          "¿Otra vez? ¡Me tenéis manía!",
          "{Count} veces a casa {ritmo}. Te la estoy guardando, {rival}.",
          "Muy bien, {rival}, apúntate a la lista. Me la cobro.",
          "¡Basta ya! La próxima la pago con intereses.",
        ],
        third_six_self: [
          "¿Tres seises y castigo? ¡Qué injusticia!",
          "¡Argh! Ni la suerte me aguanta.",
          "Vale, el dado se ha pasado de entusiasta.",
          "¡Tres seises! Hasta el dado quiere pelea.",
        ],
        third_six_tease: [
          "¡Ja! Eso por correr tanto, {rival}.",
          "Tres seises, {rival}. Ni el dado te quiere.",
          "¡Castigo sin que yo mueva un dedo! Gracias, dado. Mala suerte, {rival}.",
          "{rival}, el dado acaba de hacerme un favor.",
        ],
        goal: [
          "¡Una dentro! Las demás van detrás.",
          "¡Meta! Esto va en serio.",
          "Una menos. Temblad.",
          "¡Dentro! Y sin pedir permiso.",
        ],
        finish_place: [
          "¡Terminé! No es el oro, pero aquí estoy.",
          "Fuera de la partida, pero con la cabeza alta.",
          "Hecho. La próxima vez, el primer puesto.",
          "Meta completa. Que conste que he dado guerra.",
        ],
        ambient_ahead: [
          "Voy ganando. ¡Que se note!",
          "{rival}, ¿necesitas un mapa? Vas muy mal.",
          "¿Esto es todo lo que tenéis?",
          "Ganando y con hambre. Mala combinación para vosotros.",
        ],
        ambient_behind: [
          "Calma, {rival}. Ya te alcanzo.",
          "Voy perdiendo, sí. Por ahora.",
          "{rival}, mira por el retrovisor. Ya llego.",
          "Esto se remonta. Seguro.",
        ],
      },
    },
  },
  {
    id: "ai-purple",
    name: "Don Ernesto",
    color: "purple",
    title: "El estratega",
    personality:
      "Calculador, algo pedante y orgulloso de su método. Habla con formalidad y términos técnicos.",
    catchphrases: ["Previsible", "Todo según lo previsto", "Estadísticamente era inevitable"],
    strategy: {
      // Posicional: barreras y control del tablero; no se expone; avanza sin prisa.
      multipliers: {
        ...NEUTRAL_STRATEGY.multipliers,
        threatPerEnemy: 1.5,
        blockade: 3,
        progressPerStep: 0.7,
      },
      randomness: 0,
    },
    chat: {
      register: "Formal, trata de usted, términos técnicos y probabilidades. Elogia con condescendencia.",
      talkativeness: 0.6,
      lines: {
        victory_win: [
          "Victoria. Todo según lo previsto.",
          "Primer puesto. La estrategia, como siempre, se impone al azar.",
          "Estadísticamente era inevitable. Primer puesto asegurado.",
          "Un final de manual. Cerrar bien es lo que distingue a un estratega.",
          "Ganado. Les recomiendo revisar sus aperturas.",
        ],
        victory_reply: [
          "Enhorabuena, {rival}. Admito que su juego fue… eficaz.",
          "Felicidades, {rival}, aunque el dado le ha favorecido notablemente.",
          "Bien jugado, {rival}. Tomo nota para la próxima.",
          "Un resultado aceptable para {rival}. Analizaré mis errores.",
        ],
        capture_boast: [
          "Previsible, {rival}. Ha dejado esa ficha sin cobertura.",
          "Lo siento, {rival}. Era la jugada óptima.",
          "Una captura de libro. Nada personal, {rival}.",
          "{rival}, le recomiendo no dejar fichas sueltas.",
          "Captura ejecutada. El cálculo no falla, {rival}.",
        ],
        capture_lament: [
          "Interesante, {rival}. Un riesgo que no había considerado.",
          "Lo anoto, {rival}. No volverá a ocurrir.",
          "Un contratiempo táctico, {rival}. Nada más.",
          "Bien visto, {rival}. Ahora me toca reorganizarme.",
        ],
        streak_boast: [
          "{Count} capturas {ritmo}. Mi plan funciona mejor de lo esperado.",
          "{rival}, empieza a ser un patrón. Revise su defensa.",
          "Otra captura. Pura eficiencia.",
          "La presión constante da frutos, {rival}.",
          "Ya son {count} capturas. La teoría se confirma en la práctica.",
          "Eficacia demostrada, {rival}: {count} capturas {ritmo}.",
        ],
        streak_lament: [
          "{Count} capturas {ritmo}. Debo replantear mi defensa.",
          "{rival}, súmese usted a la lista. Esto empieza a ser un ensañamiento.",
          "Una racha adversa. Estadísticamente se compensará.",
          "Esto ya no es azar, {rival}: es una pésima posición. Mía, me temo.",
        ],
        third_six_self: [
          "Tres seises. Un caso estadísticamente desafortunado.",
          "La probabilidad era de una entre doscientas dieciséis. Qué suerte la mía.",
          "Penalización aceptada. El reglamento es el reglamento.",
          "Ni el mejor plan resiste tres seises seguidos.",
        ],
        third_six_tease: [
          "Tres seises, {rival}. Una entre doscientas dieciséis. Notable.",
          "El exceso de fortuna también se paga, {rival}.",
          "{rival}, el reglamento es implacable. Y justo.",
          "Curioso, {rival}: demasiada suerte también penaliza.",
        ],
        goal: [
          "Una ficha en meta. Avance metódico.",
          "Otra fase completada. Prosigamos.",
          "Ficha asegurada. Ya no corre ningún riesgo.",
          "Una más en meta. Todo según el plan.",
        ],
        finish_place: [
          "He terminado. No es el puesto que calculé, pero es digno.",
          "Partida concluida para mí. Revisaré los datos.",
          "Fin de mi recorrido. Una actuación correcta.",
          "Terminado. El análisis posterior será largo.",
        ],
        ambient_ahead: [
          "La posición es sólida. Sigamos así.",
          "{rival}, debería reforzar su retaguardia.",
          "El control del tablero empieza a ser evidente.",
          "Mantengo la ventaja. Paciencia y método.",
        ],
        ambient_behind: [
          "Voy por detrás, pero la partida es larga, {rival}.",
          "Una desventaja temporal. Nada que un buen plan no corrija.",
          "{rival}, no confunda ventaja con victoria.",
          "Estoy recalculando. Todavía hay margen.",
        ],
      },
    },
  },
  {
    id: "ai-green",
    name: "Abuela Pilar",
    color: "green",
    title: "La prudente",
    personality:
      "Tranquila, cariñosa y paciente, más astuta de lo que parece. Usa refranes y diminutivos.",
    catchphrases: ["Despacito y buena letra", "Ay, hijo, qué prisas", "Quien ríe el último…"],
    strategy: {
      // Conservadora: evita el peligro, busca seguros y prioriza el pasillo y la meta.
      multipliers: {
        ...NEUTRAL_STRATEGY.multipliers,
        capture: 0.8,
        reachGoal: 1.25,
        enterFinalStretch: 1.5,
        landOnSafeCell: 2,
        threatPerEnemy: 2,
        blockade: 1.5,
        huntPerTarget: 0,
      },
      randomness: 0,
    },
    chat: {
      register: "Cariñosa y tranquila: refranes, diminutivos, «cariño», «hijos». Nunca se enfada de verdad.",
      talkativeness: 0.6,
      lines: {
        victory_win: [
          "Ay, qué alegría. Despacito y buena letra, hijos.",
          "He ganado yo. ¿Quién lo iba a decir?",
          "Quien ríe el último ríe mejor… pero yo he llegado primera.",
          "Gané, cariños. La paciencia es la madre de la ciencia.",
          "¡Qué ilusión! Esto lo celebramos con chocolate.",
        ],
        victory_reply: [
          "Muy bien, {rival}, cariño. Te lo has ganado.",
          "Enhorabuena, {rival}. Ya decía yo que tenías buena mano.",
          "Bien hecho, {rival}. Pero no te lo creas mucho, ¿eh?",
          "Felicidades, {rival}. A la próxima, la abuela se pone seria.",
        ],
        capture_boast: [
          "Perdona, {rival}, cielo. Es el juego.",
          "Ay, {rival}, a casita. No me lo tengas en cuenta.",
          "Lo siento, {rival}. Quien se pone a tiro…",
          "Sin rencores, {rival}. A casita a descansar.",
          "Ay, qué pena… bueno, no tanta. A casita, {rival}.",
        ],
        capture_lament: [
          "Ay, {rival}, qué prisas. Con la abuela no se hace eso.",
          "Bueno, {rival}. No hay mal que por bien no venga.",
          "Ay, mi fichita. Paciencia, que la partida es larga, {rival}.",
          "{rival}, a la abuela se la respeta, ¿eh?",
        ],
        streak_boast: [
          "Otra más. Ya sabéis: a quien madruga…",
          "Ay, {rival}, a casita tú también. Qué cosas.",
          "Ya llevo {count} {ritmo}. La abuela también sabe.",
          "Uy, {rival}, se me está dando bien esto.",
        ],
        streak_lament: [
          "Otra vez a casa… Ay, Señor, dame paciencia.",
          "¿Pero qué os he hecho yo, cariños? Ya van {count}.",
          "{Count} veces a casita {ritmo}. Paciencia, Pilar.",
          "Ya van {count}… Esto me pasa por fiarme, {rival}.",
        ],
        third_six_self: [
          "Tres seises… Ay, la avaricia rompe el saco.",
          "Ya decía yo que tanta suerte no era normal.",
          "Bueno, turno perdido. Sin prisa.",
          "Ay, qué disgusto. Paciencia, Pilar, paciencia.",
        ],
        third_six_tease: [
          "Ay, {rival}, quien juega con fuego se quema.",
          "Tanta prisa, {rival}, y mira.",
          "{rival}, cariño, quien mucho corre pronto para.",
          "Ya te lo decía yo, {rival}: despacito.",
        ],
        goal: [
          "Una fichita en la meta. Despacito y buena letra.",
          "Ya tengo otra a salvo. Qué tranquilidad.",
          "Paso a paso se llega lejos.",
          "Una más en la meta. Poquito a poco.",
        ],
        finish_place: [
          "Ya he terminado. Me quedo tan ancha.",
          "Hecho, hijos. Lo importante es participar.",
          "Terminé. No he ganado, pero me lo he pasado de maravilla.",
          "Fin para mí. Ahora, a por la merienda.",
        ],
        ambient_ahead: [
          "Voy bien, ¿eh? Sin correr, pero sin parar.",
          "{rival}, cariño, no te quedes atrás.",
          "Poquito a poco voy llegando.",
          "Ay, qué tranquila voy. Así da gusto.",
        ],
        ambient_behind: [
          "No corras tanto, {rival}, que te vas a cansar.",
          "Voy perdiendo, pero quien ríe el último…",
          "Sin prisa, {rival}. La tortuga también llegó.",
          "Mucho correr, mucho correr… ya veremos al final, {rival}.",
        ],
      },
    },
  },
  {
    id: "ai-blue",
    name: "Chispa",
    color: "blue",
    title: "El imprevisible",
    personality:
      "Bromista, despreocupado y supersticioso; cree en las rachas. Informal, con juegos de palabras y tono de comentarista.",
    catchphrases: ["¡Y el dado dice…!", "Hoy es mi día", "Esto es Parchís, señores"],
    strategy: {
      // Corredor: prioriza avanzar, apenas forma barreras y tiene un azar acotado.
      multipliers: {
        ...NEUTRAL_STRATEGY.multipliers,
        progressPerStep: 2,
        blockade: 0.5,
      },
      randomness: MAX_RANDOMNESS,
    },
    chat: {
      register: "Informal y teatral, como un comentarista: bromas, supersticiones y juegos de palabras.",
      talkativeness: 1,
      lines: {
        victory_win: [
          "¡Y el ganador eeees… Chispa! ¡Gracias, gracias!",
          "¡Hoy es mi día! Lo decía el horóscopo.",
          "¡Victoria! Esto es Parchís, señores.",
          "¡Ganador! Que alguien saque el confeti.",
          "¡Lo sabía! Llevaba los calcetines de la suerte.",
        ],
        victory_reply: [
          "¡Ovación para {rival}! Pero que no se acostumbre.",
          "¡Bravo, {rival}! Primer puesto...luego me firmas un autógrafo.",
          "¡Felicidades, {rival}! Exijo revancha y palomitas.",
          "Y {rival} se lleva la gloria. ¡Qué carrera, señores!",
        ],
        capture_boast: [
          "¡Y el dado dice… a casa, {rival}!",
          "¡Uy, perdón, {rival}! Ha sido sin querer… queriendo.",
          "¡Captura en directo! {rival}, saluda a cámara.",
          "¡Pim, pam, fuera! Lo siento, {rival}.",
          "{rival}, te he mandado de vacaciones a casa.",
          "¡Atención, señores: {rival} regresa a casa en directo!",
          "¡Abracadabra! {rival}, tu ficha ha desaparecido del tablero.",
          "¡Golazo por la escuadra! {rival}, a casa a por agua.",
        ],
        capture_lament: [
          "¡Noooo! {rival}, eso ha dolido.",
          "¡Me han cazado! Mal día para dejarme el amuleto, {rival}.",
          "¡Qué jugada, {rival}! Bueno, para ti.",
          "Vale, {rival}. Pido el VAR.",
          "¡Repetición, por favor! {rival}, eso ha sido falta.",
          "¡Mi ficha! {rival}, que conste que la estaba calentando.",
          "Señores, me han cazado en directo. {rival}, te veo en la revancha.",
        ],
        streak_boast: [
          "¡Y van {count}! Esto se pone caliente, señores.",
          "¡Racha, racha, racha! {rival}, lo siento, de verdad… un poco.",
          "¡Otra! Hoy los astros están conmigo.",
          "¡{Count} capturas {ritmo}! {rival}, ya puedes ir haciendo hueco en casa.",
          "¡Esto es un récord, señores! {Count} capturas {ritmo}.",
          "¡Que alguien avise a la prensa! {rival}, tú también a casa.",
        ],
        streak_lament: [
          "¿Otra vez? Esto ya es gafe, {rival}.",
          "¡{Count} veces {ritmo}! Alguien me ha echado mal de ojo.",
          "{rival}, ¿tú también? Esto ya es una conspiración.",
          "Mi ficha pasa más tiempo en casa que en el tablero.",
        ],
        third_six_self: [
          "¡Tres seises! El dado se ha venido arriba.",
          "¡Lo sabía! Tres seises son el gato negro del Parchís.",
          "Demasiada suerte junta. Ya decía yo.",
          "¡Seis, seis, seis… y castigo! Qué guion.",
        ],
        third_six_tease: [
          "¡Tres seises para {rival}! El dado ha dictado sentencia.",
          "¡Uyyy, {rival}! La suerte se cobra intereses.",
          "¡Momento histórico! {rival} y sus tres seises.",
          "{rival}, eso pasa por no tocar madera.",
        ],
        goal: [
          "¡Ficha en meta! ¡Gooool!",
          "¡Una dentro! Que suene la música.",
          "¡Y entra! El público enloquece.",
          "¡Meta! Esto merece repetición a cámara lenta.",
        ],
        finish_place: [
          "¡Terminé! Y con estilo.",
          "¡Meta completa! No he ganado, pero qué espectáculo.",
          "Fin de mi carrera. ¡Qué viaje, señores!",
          "¡Listo! Misión cumplida.",
        ],
        ambient_ahead: [
          "¡Voy en cabeza! Que no pare la música.",
          "{rival}, ¿te has quedado a merendar? Vas muy atrás.",
          "Voy ganando, señores. Que siga la fiesta.",
          "¡Hoy es mi día! O eso dice mi amuleto.",
        ],
        ambient_behind: [
          "{rival} va lanzado. Pero aquí hay partido.",
          "Voy perdiendo, pero en las remontadas soy un experto.",
          "¡Que no decaiga! {rival}, te estoy vigilando.",
          "Esto se arregla con un par de seises. Ni uno más.",
        ],
      },
    },
  },
];

export const CHARACTER_IDS: readonly PlayerId[] = CHARACTERS.map((c) => c.id);

export const CHARACTER_NAMES: Readonly<Record<PlayerId, string>> = Object.fromEntries(
  CHARACTERS.map((c) => [c.id, c.name]),
);

/** Personaje del catálogo, o `undefined` si el id no está en él. */
export const getCharacter = (playerId: PlayerId): Character | undefined => CHARACTERS.find((c) => c.id === playerId);

/** Estrategia del jugador; `NEUTRAL_STRATEGY` si no es un personaje del catálogo. */
export function getStrategy(playerId: PlayerId): StrategyProfile {
  return CHARACTERS.find((c) => c.id === playerId)?.strategy ?? NEUTRAL_STRATEGY;
}

// Comprobaciones al cargar el módulo: orden de colores del motor y perfiles válidos.
if (CHARACTERS.some((c, i) => c.color !== COLORS[i])) {
  throw new Error("CHARACTERS debe seguir el orden de COLORS del motor");
}
for (const { id, strategy, chat } of CHARACTERS) {
  if (!(chat.talkativeness > 0 && chat.talkativeness <= 1)) throw new Error(`Frecuencia de chat no válida en ${id}`);
  if (CHAT_LINE_KINDS.some((kind) => chat.lines[kind].length === 0)) throw new Error(`Faltan frases de chat en ${id}`);
  for (const kind of CHAT_LINE_KINDS) {
    for (const line of chat.lines[kind]) {
      for (const [, marker] of line.matchAll(/\{(\w+)\}/g)) {
        const allowed =
          (marker === "rival" && LINE_KINDS_WITH_RIVAL.has(kind)) ||
          (["count", "Count", "ritmo"].includes(marker) && LINE_KINDS_WITH_STREAK.has(kind));
        if (!allowed) throw new Error(`Marcador {${marker}} no permitido en ${id}/${kind}: ${line}`);
      }
    }
  }
  const values = Object.values(strategy.multipliers);
  if (values.some((m) => !Number.isFinite(m) || m < 0)) {
    throw new Error(`Multiplicadores no válidos en ${id}`);
  }
  if (!(strategy.randomness >= 0 && strategy.randomness <= MAX_RANDOMNESS)) {
    throw new Error(`Azar no válido en ${id}`);
  }
}
