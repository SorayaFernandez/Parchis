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
 * - ambient_lead: primero en solitario, el único que afirma ir ganando ({rival} = último en solitario)
 * - ambient_ahead: sin liderar, frase neutral de progreso que no afirma posición ({rival} = último en solitario)
 * - ambient_behind: alguien va por delante, «voy perdiendo» ({rival} = primero en solitario)
 * - blockade_complaint: una barrera de {rival} le corta el paso de verdad en esta tirada («¡Abre la barrera!»)
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
  "ambient_lead",
  "ambient_ahead",
  "ambient_behind",
  "blockade_complaint",
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
  "ambient_lead",
  "ambient_ahead",
  "ambient_behind",
  "blockade_complaint",
]);

/** Tipos que tienen frases propias de réplica (`replies`): las capturas, que es donde más se contesta. */
export const REPLY_LINE_KINDS: ReadonlySet<ChatLineKind> = new Set(["capture_boast", "capture_lament"]);

export interface ChatProfile {
  /** Registro y tono (referencia para la generación de texto; en 8.2b irá al prompt). */
  register: string;
  /**
   * Estilo para el prompt del LLM, descrito sin frases hechas concretas (las coletillas literales no se
   * envían: el modelo las imitaba). Se comprueba al cargar que no contiene ninguna coletilla.
   */
  voice: string;
  /** Ganas de hablar, de 0 a 1: multiplica la probabilidad de intervenir y de replicar. */
  talkativeness: number;
  /**
   * Parte orientativa de las intervenciones espontáneas (mensajes principales) que le toca en una partida.
   * El director la usa para repartir la palabra sin cuotas rígidas (ver `balanceFactor` en director.ts).
   * Las cuatro suman 1.
   */
  share: number;
  /** Frases locales por tipo de intervención (también son la reserva si falla un LLM en 8.2b). */
  lines: Readonly<Record<ChatLineKind, readonly string[]>>;
  /**
   * Frases para contestar a otro personaje (réplicas), por tipo (`REPLY_LINE_KINDS`). Contestan al mensaje
   * anterior en lugar de repetirlo («Sí, te comí la ficha», «¡Esto no se queda así!»). Si no hay ninguna
   * válida, la réplica usa las frases normales de su tipo.
   */
  replies: Readonly<Partial<Record<ChatLineKind, readonly string[]>>>;
}

export interface Character {
  id: PlayerId;
  /** Nombre visible. */
  name: string;
  /**
   * Género gramatical con el que se habla de este personaje y con el que él habla de sí mismo
   * (concordancia de apelativos y adjetivos: «hijita» a Brava, «hijito» a Chispa).
   */
  gender: "f" | "m";
  /** Color que le asigna `createGame()` por su posición en el catálogo. */
  color: Color;
  /** Arquetipo en pocas palabras. */
  title: string;
  /** Personalidad y forma de hablar. */
  personality: string;
  /**
   * Expresiones habituales. No se envían al LLM: sirven para detectar coletillas repetidas (registro de
   * la partida y validador). Varias aparecen en `chat.lines`.
   */
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
    gender: "f",
    color: "pink",
    title: "La agresiva",
    personality:
      "Competitiva, directa y algo provocadora; se pica enseguida. Frases cortas, exclamaciones y tono de reto.",
    catchphrases: ["¡A casa!", "Voy a por ti", "Eso no ha sido nada"],
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
      register: "Frases cortas y directas, con exclamaciones. Reta, presume y protesta; nunca insulta.",
      voice: "Competitiva, directa y desafiante: pica a sus rivales, presume cuando le sale bien una jugada y protesta cuando le sale mal, sin pasarse ni insultar.",
      talkativeness: 1,
      share: 0.27,
      lines: {
        victory_win: [
          "¡Primera! ¿Alguien lo dudaba?",
          "¡Gané! Lo sabía.",
          "¡Eso es! Os he ganado a todos.",
          "¡Primera en llegar! Así se juega.",
          "¡Gané!",
        ],
        victory_reply: [
          "Disfrútalo, {rival}. La próxima es mía.",
          "Bah, {rival} ha tenido suerte con el dado.",
          "Vale, {rival}, esta vez has ganado tú. La revancha, ya.",
          "¡Felicidades, {rival}! Que te dure poco.",
        ],
        capture_boast: [
          "¡A casa, {rival}!",
          "¡Hasta luego, {rival}!",
          "¡Te he comido, {rival}! Vuelta a empezar.",
          "Eso por ponerte en mi camino, {rival}.",
          "¡Te vi venir, {rival}!",
          "¡Te pillé, {rival}! Aquí mando yo.",
          "¡Para casa, {rival}! Ni lo has visto venir.",
        ],
        capture_lament: [
          "¡Esto no queda así, {rival}!",
          "Disfrútalo mientras puedas, {rival}.",
          "Vale, {rival}. Ahora voy a por ti.",
          "¿Me has comido? Te vas a enterar, {rival}.",
          "Apúntatelo, {rival}: esta me la cobro.",
          "¡Qué rabia! Ya verás la próxima, {rival}.",
        ],
        streak_boast: [
          "¡Otra más, {rival}!",
          "¡{Count} capturas {ritmo}! Hoy no fallo.",
          "¡Ya me he comido {count} fichas!",
          "Hoy me salen todas, {rival}.",
          "{Count} {ritmo}. ¡Y voy a por más!",
        ],
        streak_lament: [
          "¿Otra vez? ¡Me tenéis manía!",
          "{Count} veces a casa {ritmo}. Te la estoy guardando, {rival}.",
          "Muy bien, {rival}, apúntate a la lista. Me la cobro.",
          "¡Basta ya! Ahora os toca a vosotros.",
        ],
        third_six_self: [
          "¿Tres seises y castigo? ¡Qué injusticia!",
          "¡Jo! Ni la suerte me acompaña.",
          "¡Encima pierdo el turno! Hay que fastidiarse.",
          "¡Tres seises! Qué mala pata.",
        ],
        third_six_tease: [
          "¡Ja! Eso por correr tanto, {rival}.",
          "Tres seises, {rival}. Te quedas sin turno.",
          "¡Castigo sin mover un dedo! Mala suerte, {rival}.",
          "{rival}, ¡te has pasado de seises!",
        ],
        goal: [
          "¡Una dentro! Las demás van detrás.",
          "¡Meta! Esto va en serio.",
          "Una menos. ¡A por las demás!",
          "¡Otra en la meta! Esto marcha bien.",
        ],
        finish_place: [
          "¡Terminé! Y no me he rendido ni un momento.",
          "Terminé. No era el puesto que quería, pero aquí sigo.",
          "Hecho. La próxima vez, el primer puesto.",
          "Meta completa. Que conste que he dado guerra.",
        ],
        ambient_lead: [
          "Voy ganando. ¡Que se note!",
          "Voy ganando. Así me gusta.",
          "Voy ganando. Hoy me salen las tiradas.",
          "{rival}, ¿te espero? Te has quedado muy atrás.",
        ],
        ambient_ahead: [
          "Todavía no he terminado. ¡Queda partida!",
          "Al primero que se me ponga a tiro, lo mando a casa.",
          "¡Aquí no se rinde nadie! Y yo, menos.",
          "{rival}, espabila, que te estás quedando atrás.",
        ],
        ambient_behind: [
          "Calma, {rival}. Ya te alcanzo.",
          "Voy perdiendo, sí. Por ahora.",
          "{rival}, no te confíes. Voy a por ti.",
          "Esto se remonta. Seguro.",
        ],
        blockade_complaint: [
          "¡Abre la barrera, {rival}!",
          "{rival}, quita esa barrera, que no paso.",
          "¡Venga, {rival}, abre ya!",
          "Esa barrera me corta el paso, {rival}.",
        ],
      },
      replies: {
        capture_boast: [
          "¡Pues claro! Y voy a por más.",
          "¡Haberte apartado, {rival}!",
          "Así se juega, {rival}.",
          "¡Ya lo creo! Te comí la ficha.",
        ],
        capture_lament: [
          "¿Ah, sí? Pues ahora voy a por ti.",
          "Disfrútalo, que te dura poco, {rival}.",
          "¡Esto no se queda así!",
          "Ya te pillaré, {rival}. Tú espera.",
        ],
      },
    },
  },
  {
    id: "ai-purple",
    name: "Don Ernesto",
    gender: "m",
    color: "purple",
    title: "El estratega",
    personality:
      "Calculador, tranquilo y educado, orgulloso de su método. Habla con cierta formalidad y trata de usted, sin tecnicismos.",
    catchphrases: ["Previsible", "Lo tenía calculado", "Era de esperar"],
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
      register: "Formal sin ser rígido: trata de usted, piensa en probabilidades y elogia con algo de condescendencia.",
      voice: "Estratega sereno, calculador y educado: siempre trata de usted y habla con precisión, con algo de cálculo y probabilidad, pero con naturalidad y sin tecnicismos.",
      talkativeness: 1,
      share: 0.27,
      lines: {
        victory_win: [
          "Primer puesto. Ha salido como pensaba.",
          "Primer puesto. Cada jugada tenía su porqué.",
          "He ganado. Era lo más probable.",
          "He ganado. El plan ha funcionado de principio a fin.",
          "Gano yo. Les recomiendo repasar sus jugadas.",
        ],
        victory_reply: [
          "Enhorabuena, {rival}. Admito que su juego fue… eficaz.",
          "Felicidades, {rival}, aunque ha tenido buenas tiradas.",
          "Bien jugado, {rival}. Tomo nota para la próxima.",
          "Merecido, {rival}. Yo tendré que pensar en qué fallé.",
        ],
        capture_boast: [
          "Previsible, {rival}. Le comí.",
          "Lo siento, {rival}. Era la mejor jugada.",
          "He comido su ficha, {rival}. Nada personal.",
          "{rival}, le recomiendo no dejar fichas sueltas.",
          "Me como su ficha, {rival}. Lo tenía calculado.",
          "Le he comido su ficha, {rival}.",
        ],
        capture_lament: [
          "Interesante, {rival}. Un riesgo que no había considerado.",
          "Lo anoto, {rival}. Me ha pillado desprevenido.",
          "Me comió usted, {rival}. Tomo nota.",
          "Me ha comido una ficha, {rival}. Tendré que reorganizarme.",
        ],
        streak_boast: [
          "{Count} capturas {ritmo}. Mi plan funciona mejor de lo esperado.",
          "{rival}, empieza a ser costumbre. Revise su defensa.",
          "Otra captura. Las cuentas salen.",
          "Le he comido, {rival}. Era de esperar.",
          "Ya son {count} capturas. Y no por casualidad.",
          "{Count} capturas {ritmo}, {rival}. Le aconsejo más cuidado.",
        ],
        streak_lament: [
          "{Count} capturas {ritmo}. Debo replantear mi defensa.",
          "{rival}, súmese usted a la lista. Ya son demasiadas.",
          "Últimamente no me salen las tiradas. Ya cambiará.",
          "Esto ya no es azar, {rival}. Debo proteger mejor mis fichas.",
        ],
        third_six_self: [
          "Tres seises. Qué mala suerte, la verdad.",
          "La probabilidad era de una entre doscientas dieciséis. Qué suerte la mía.",
          "Penalización aceptada. Las reglas son las reglas.",
          "Ni el mejor plan resiste tres seises seguidos.",
        ],
        third_six_tease: [
          "Tres seises, {rival}: una entre doscientas dieciséis. Notable.",
          "Tres seises, {rival}. Pierde el turno.",
          "{rival}, son las reglas. Y me parecen muy justas.",
          "Curioso, {rival}: demasiada suerte también penaliza.",
        ],
        goal: [
          "Una ficha en meta. Vamos bien.",
          "Otra ficha que llega a la meta. Sigamos con calma.",
          "Ficha asegurada. Ya no corre ningún riesgo.",
          "Una más en meta. Seguimos.",
        ],
        finish_place: [
          "He terminado. No es el puesto que calculé, pero es digno.",
          "Todas mis fichas en meta. No ha estado mal.",
          "Fin de mi recorrido. Una partida correcta.",
          "Terminado. Me tocará repasar la partida con calma.",
        ],
        ambient_lead: [
          "Las cuentas me salen, de momento.",
          "Voy ganando, y sin arriesgar.",
          "Encabezo la partida, tal como había calculado.",
          "{rival}, le saco ventaja. Debería reaccionar.",
        ],
        ambient_ahead: [
          "Analizo cada tirada. El plan sigue en marcha.",
          "{rival}, debería proteger mejor sus fichas.",
          "Cada movimiento suma. Sigamos con método.",
          "Todo está por decidir. Lo calculo con calma.",
        ],
        ambient_behind: [
          "Voy por detrás, pero la partida es larga, {rival}.",
          "Una desventaja temporal. Nada que un buen plan no corrija.",
          "{rival}, no confunda ventaja con victoria.",
          "Todavía hay margen. Con calma se remonta.",
        ],
        blockade_complaint: [
          "{rival}, abra usted la barrera, por favor.",
          "Su barrera me cierra el paso, {rival}.",
          "Cuando guste, {rival}, abra la barrera.",
          "{rival}, con esa barrera no hay forma de pasar.",
        ],
      },
      replies: {
        capture_boast: [
          "En efecto, {rival}. Le comí la ficha.",
          "Era la jugada correcta, lo siento.",
          "Cosas del juego, {rival}.",
          "No se lo tome a mal, {rival}.",
        ],
        capture_lament: [
          "Muy bien jugado, {rival}. Lo tendré en cuenta.",
          "Tiene usted razón, {rival}: me descuidé.",
          "Lo reconozco, {rival}: esta vez ha acertado usted.",
          "Ya habrá ocasión de devolvérsela, {rival}.",
        ],
      },
    },
  },
  {
    id: "ai-green",
    name: "Abuela Pilar",
    gender: "f",
    color: "green",
    title: "La prudente",
    personality:
      "Tranquila, cariñosa y paciente, más astuta de lo que parece. Usa alguna expresión de toda la vida y, cuando una ficha vuelve a casa, «casita».",
    catchphrases: ["Despacito y buena letra", "Ay, hijo, qué prisas", "Sin prisa"],
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
      register: "Cariñosa y tranquila: diminutivos, «cariño», «hijos» y algún refrán de vez en cuando. Nunca se enfada de verdad.",
      voice: "Prudente, cariñosa y paciente, algo tradicional: habla con cercanía y calma y solo usa algún refrán si viene a cuento, sin repetirlo. Solo dice «casita» si una ficha vuelve a casa.",
      talkativeness: 0.65,
      share: 0.19,
      lines: {
        victory_win: [
          "Ay, qué alegría. He ganado, hijos.",
          "He ganado yo. ¿Quién lo iba a decir?",
          "Ya está, hijos: he llegado primera.",
          "Gané, hijos. Poquito a poco, pero gané.",
          "¡Qué ilusión! No me lo esperaba.",
        ],
        victory_reply: [
          "Muy bien, {rival}, cariño. Te lo has ganado.",
          "Enhorabuena, {rival}. Ya decía yo que tenías buena mano.",
          "Bien hecho, {rival}. Pero no te lo creas mucho.",
          "Felicidades, {rival}. A la próxima, la abuela se pone seria.",
        ],
        capture_boast: [
          "Perdona, {rival}, cielo. Es el juego.",
          "Ay, {rival}, a casita. No me lo tengas en cuenta.",
          "Lo siento, {rival}. Quien se pone a tiro…",
          "Sin rencores, {rival}. A casita a descansar.",
          "Ay, qué pena. A casita, {rival}.",
        ],
        capture_lament: [
          "Ay, {rival}, qué prisas por comerme. Con la abuela no se hace eso.",
          "Bueno, {rival}, mi ficha a casita. No hay mal que por bien no venga.",
          "Ay, mi ficha. Paciencia, que la partida es larga, {rival}.",
          "Me has comido, {rival}... pero qué le vamos a hacer.",
          "Vaya, {rival}, me has pillado. Ya me tocará a mí.",
        ],
        streak_boast: [
          "Otra más, cariño. Quién me lo iba a decir.",
          "Ay, {rival}, a casita tú también. Qué cosas.",
          "Ya llevo {count} {ritmo}. La abuela también sabe.",
          "Uy, {rival}, se me está dando bien esto.",
        ],
        streak_lament: [
          "Otra vez a casa… Ay, Señor, dame paciencia.",
          "¿Pero qué os he hecho yo, hijos? Ya van {count}.",
          "{Count} veces a casita {ritmo}. Paciencia y buena cara.",
          "Ya van {count}… Esto me pasa por fiarme, {rival}.",
        ],
        third_six_self: [
          "Tres seises… Ay, qué pena.",
          "Ya decía yo que tanta suerte no era normal.",
          "Bueno, turno perdido. Sin prisa.",
          "Ay, qué disgusto. Paciencia, mucha paciencia.",
        ],
        third_six_tease: [
          "Las prisas nunca son buenas, {rival}.",
          "Tanta prisa, {rival}, y mira.",
          "{rival}, cariño, pierdes el turno.",
          "Ya te lo decía yo, {rival}.",
        ],
        goal: [
          "Una ficha más en la meta. Despacito y buena letra.",
          "Ya tengo otra a salvo. Qué tranquilidad.",
          "Una ficha menos por mover. Qué gusto.",
          "Una más en la meta. Poquito a poco.",
        ],
        finish_place: [
          "Ya he terminado, hijos.",
          "Hecho, hijos. Lo importante es participar.",
          "Terminé. No he ganado, pero me lo he pasado de maravilla.",
          "Fin para mí. Ha estado bien.",
        ],
        ambient_lead: [
          "Ay, quién me lo iba a decir: voy ganando.",
          "Voy ganando, hijos. Paso a paso.",
          "La abuela va ganando. Tomad nota, hijos.",
          "{rival}, cariño, te espero en la meta.",
        ],
        ambient_ahead: [
          "Sin correr, pero sin parar, cariño.",
          "{rival}, cariño, no te quedes atrás.",
          "Poquito a poco voy avanzando.",
          "Qué tranquila voy. Así da gusto.",
        ],
        ambient_behind: [
          "No corras tanto, {rival}, que te vas a cansar.",
          "Voy perdiendo. Ya llegaré.",
          "Sin prisa, {rival}. Esto es muy largo todavía.",
          "Mucho correr, mucho correr… ya veremos al final, {rival}.",
        ],
        blockade_complaint: [
          "Esa barrera, {rival}… ¿la abres o qué?",
          "Por favor, {rival}, deja pasar a la abuela.",
          "Déjame pasar, {rival}, abre la barrera.",
          "Con esa barrera no hay quien pase, {rival}.",
        ],
      },
      replies: {
        capture_boast: [
          "Ay, {rival}, a casita. Te tocaba.",
          "Lo siento, {rival}, pero me tocaba.",
          "Cosas del parchís, cariño.",
          "Otra vez será, {rival}, ya verás.",
        ],
        capture_lament: [
          "Bueno, otra vez a empezar.",
          "Ya me las pagarás, {rival}.",
          "Pues nada, ya me tocará a mí.",
          "Paciencia, que ya te alcanzaré.",
        ],
      },
    },
  },
  {
    id: "ai-blue",
    name: "Chispa",
    gender: "m",
    color: "blue",
    title: "El imprevisible",
    personality:
      "Espontáneo, alegre e impulsivo, algo travieso; supersticioso con el dado. Habla de forma informal y cercana.",
    catchphrases: ["¡Qué mala pata!", "Hoy es mi día", "¡Toma ya!"],
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
      register: "Informal y alegre: reacciona con sorpresa y humor, con alguna superstición con el dado y frases sencillas.",
      voice: "Espontáneo, alegre e imprevisible: reacciona con sorpresa y dice lo que piensa con frases sencillas, sin exagerar.",
      talkativeness: 1,
      share: 0.27,
      lines: {
        victory_win: [
          "¡He ganado! ¡Qué partidón!",
          "¡Hoy es mi día! He ganado.",
          "¡Primero! Qué bien me ha salido.",
          "¡Gané! Y eso que empecé fatal.",
          "¡Lo sabía! Hoy tenía buena mano.",
        ],
        victory_reply: [
          "¡Bien jugado, {rival}! Pero quiero la revancha.",
          "¡Enhorabuena, {rival}! Hoy te ha salido todo.",
          "¡Felicidades, {rival}! Esta vez te la dejo.",
          "Vale, {rival}, has ganado tú. Ahora, a por el segundo puesto.",
        ],
        capture_boast: [
          "¡Te comí, {rival}! A casa.",
          "¡Uy, perdón, {rival}!",
          "¡Te pillé, {rival}! A empezar de nuevo.",
          "¡Bien! {rival}, vuelves a empezar.",
          "Lo siento, {rival}. Te he comido.",
          "¡Toma ya! {rival}, a casa.",
        ],
        capture_lament: [
          "¡Noooo! {rival}, eso ha dolido.",
          "¡Me has comido, {rival}! Qué rabia.",
          "¡Qué jugada, {rival}! Bueno, para ti.",
          "Vale, {rival}, esta me la apunto.",
          "¡Qué mala pata, {rival}! Vuelta a empezar.",
          "¡Mi ficha! {rival}, con lo bien que iba.",
          "¡Ay! {rival}, ya te pillaré yo.",
          "Maldición, me comiste la ficha, {rival}.",
        ],
        streak_boast: [
          "¡Y van {count}! Hoy no hay quien me pare.",
          "¡Otra más! Lo siento, {rival}.",
          "¡Otra! Hoy me sale todo.",
          "¡{Count} capturas {ritmo}! {rival}, ya puedes ir haciendo hueco en casa.",
          "¡{Count} capturas {ritmo}! Que no se me vaya la suerte.",
          "{rival}, tú también a casa. ¡Qué día llevo!",
        ],
        streak_lament: [
          "¿Otra vez? No me lo puedo creer, {rival}.",
          "¡{Count} veces {ritmo}! No me sale nada.",
          "¡Vaya, {rival}! Otra vez a casa, no gano para sustos.",
          "No hay manera, {rival}.",
        ],
        third_six_self: [
          "¡Tres seises! Y encima castigo.",
          "¡Lo sabía! Tres seises nunca traen nada bueno.",
          "Demasiada suerte junta. Ya decía yo.",
          "Pierdo el turno. Vaya.",
        ],
        third_six_tease: [
          "¡Tres seises, {rival}! Te toca esperar.",
          "¡Uyyy, {rival}! Tanto seis tenía trampa.",
          "¡Ay, {rival}! Ya no tiras más.",
          "{rival}, otra vez será.",
        ],
        goal: [
          "¡Ficha en meta! Qué bien.",
          "¡Una dentro! Ya queda menos.",
          "¡Y entra! Qué bien sienta.",
          "¡Meta! Ni yo me lo creo.",
        ],
        finish_place: [
          "¡Terminé, por fin!",
          "¡Meta completa! No he ganado, pero me lo he pasado genial.",
          "¡Todas en meta! Y sin perder la sonrisa.",
          "¡Listo! Ya está.",
        ],
        ambient_lead: [
          "¡Voy ganando! Que no se acabe la suerte.",
          "Voy ganando. ¡Que siga así!",
          "¡Voy ganando! Ni yo me lo esperaba.",
          "¡Mira, {rival}, voy ganando!",
        ],
        ambient_ahead: [
          "{rival}, ánimo, que vas muy atrás.",
          "¡Vamos, que se puede!",
          "¡Qué partida más reñida!",
          "Esta partida me está gustando.",
        ],
        ambient_behind: [
          "{rival} va muy rápido. Pero esto no ha acabado.",
          "Voy perdiendo, pero aún quedan muchas tiradas.",
          "¡Que no decaiga! {rival}, te estoy vigilando.",
          "Todavía puedo alcanzaros.",
        ],
        blockade_complaint: [
          "¡Eh, {rival}, que no paso!",
          "¡Esa barrera no me deja pasar!",
          "¡Venga, {rival}, abre el paso!",
          "¡Esa barrera sobra, {rival}!",
        ],
      },
      replies: {
        capture_boast: [
          "¡Sí, te comí la ficha!",
          "Te comí la ficha, jeje.",
          "¡Ups! Tocaba, {rival}.",
          "¡Jeje! A casa, {rival}.",
        ],
        capture_lament: [
          "¡Anda ya! Ya te pillaré.",
          "¡Jo! Pues ahora me toca a mí.",
          "¡Uy! Esa no la vi venir.",
          "¡Qué rabia! Ya verás la próxima.",
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
if (Math.abs(CHARACTERS.reduce((sum, c) => sum + c.chat.share, 0) - 1) > 1e-9) {
  throw new Error("Las cuotas de chat (`chat.share`) deben sumar 1");
}
for (const { id, strategy, chat, catchphrases } of CHARACTERS) {
  if (!(chat.talkativeness > 0 && chat.talkativeness <= 1)) throw new Error(`Frecuencia de chat no válida en ${id}`);
  if (!(chat.share > 0 && chat.share < 1)) throw new Error(`Cuota de chat no válida en ${id}`);
  const plain = (text: string) => text.toLowerCase().replace(/[¡!¿?….,]/g, "").trim();
  if (!chat.voice.trim() || catchphrases.some((c) => plain(chat.voice).includes(plain(c)))) {
    throw new Error(`El estilo de ${id} no puede estar vacío ni contener sus coletillas literales`);
  }
  if (CHAT_LINE_KINDS.some((kind) => chat.lines[kind].length === 0)) throw new Error(`Faltan frases de chat en ${id}`);
  for (const kind of Object.keys(chat.replies) as ChatLineKind[]) {
    if (!REPLY_LINE_KINDS.has(kind)) throw new Error(`Réplicas no permitidas en ${id}/${kind}`);
  }
  for (const kind of CHAT_LINE_KINDS) {
    for (const line of [...chat.lines[kind], ...(chat.replies[kind] ?? [])]) {
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
