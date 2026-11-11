// Límites y probabilidades del chat. Única fuente de verdad: los esquemas (schemas.ts), el director
// y el escritor leen de aquí. Los límites de almacenamiento reflejan supabase/8.2a-chat.sql y una
// prueba comprueba que coinciden.

/**
 * Límites de almacenamiento: copia de las restricciones CHECK de `public.game_messages` en el SQL.
 * Si se cambian aquí, hay que cambiar también el SQL (la prueba `config.test.ts` lo comprueba).
 */
export const CHAT_STORAGE = {
  /** `char_length(text) between 1 and 200`. */
  maxStoredTextLength: 200,
  /** `seq between 0 and 3` (0 = mensaje, 1 = réplica). */
  maxSeq: 3,
  /** `character_id ~ '^ai-[a-z]+$'`. */
  characterIdPattern: /^ai-[a-z]+$/,
} as const;

export const CHAT_LIMITS = {
  /** Mensajes como máximo por partida (incluidas las réplicas). */
  maxMessagesPerGame: 60,
  /** Mensajes que se reservan para la victoria mientras nadie ha terminado. */
  victoryReserve: 2,
  /** Versiones mínimas entre dos mensajes del mismo personaje. */
  characterCooldown: 8,
  /** Versiones mínimas entre dos intervenciones cualesquiera (una réplica va con su mensaje). */
  globalCooldown: 3,
  /** Versiones sin mensajes a partir de las cuales cabe un comentario de ambiente. */
  silenceVersions: 40,
  /** Cada cuántas versiones se valora un comentario de ambiente (evita leer el estado en cada versión). */
  ambientCheckEvery: 10,
  /** Ventana (en versiones) para detectar rachas de capturas. */
  streakWindow: 60,
  /** Capturas de un mismo personaje (o sufridas por él) en la ventana que forman una racha. */
  streakSize: 3,
  /** O bien: capturas seguidas (sin ninguna otra captura entre medias) que ya forman racha. */
  consecutiveStreakSize: 2,
  /** Capturas recientes que recuerda el director (para las rachas). */
  maxTrackedCaptures: 50,
  /** Textos recientes de la partida que se recuerdan para no repetirse. */
  recentTexts: 12,
  /**
   * Frases usadas por cada personaje que se recuerdan (de todos los tipos) para no repetirlas:
   * cada personaje agota las frases de un tipo antes de repetir ninguna.
   */
  usedLinesPerCharacter: 40,
  /** Similitud (0-1, trigramas) a partir de la cual dos textos se consideran repetidos. */
  maxSimilarity: 0.6,
  /** Longitud máxima de un mensaje publicado. */
  maxTextLength: 160,
  /**
   * Duración de la reserva de un lote (la fija PostgreSQL; `chat_claim` admite 1–60 s). No se renueva:
   * el procesador deja de empezar versiones a mitad de reserva y cada llamada al escritor tiene un
   * tiempo máximo, así que siempre confirma antes de que caduque.
   */
  leaseSeconds: 30,
  /** Fracción de la reserva a partir de la cual no se empiezan versiones nuevas (se confirma lo hecho). */
  workBudgetFraction: 0.5,
  /** Tiempo máximo de una llamada al escritor principal (un LLM en 8.2b). */
  writerTimeoutMs: 8_000,
  /** Tiempo que se deja siempre libre al final de la reserva para confirmar el lote. */
  commitMarginMs: 3_000,
  /** Si queda menos que esto para el escritor principal, se usa directamente el local. */
  minWriterMs: 500,
  /** Versiones pendientes que se reservan y confirman juntas (un lote). */
  batchSize: 25,
  /** Lotes como mucho por ejecución del procesador (el resto, en la siguiente). */
  maxBatchesPerDrain: 4,
  /**
   * Versiones con más retraso que esto respecto a la última pendiente se procesan sin hablar
   * (evita comentarios desfasados al recuperar). Nunca se aplica a la victoria.
   */
  staleVersions: 15,
  /**
   * Reservas de una versión a partir de las cuales se da por defectuosa y se salta (sin hablar),
   * para que no bloquee las siguientes. La victoria nunca se salta: se procesa en modo mínimo.
   */
  maxAttempts: 3,
  /** Mensajes de la carga inicial de la página. */
  initialMessages: 20,
  /** Mensajes por página al recuperar los posteriores a un id. */
  pageSize: 100,
  /** Navegador, partida terminada con versiones aún pendientes: espera antes de volver a consultar. */
  pendingPollMs: 2000,
  /** Espera máxima entre consultas mientras siga habiendo pendientes. */
  pendingPollMaxMs: 15_000,
} as const;

/**
 * Probabilidad base de que se hable ante cada disparador (se multiplica por las ganas de hablar).
 * Las capturas son el acontecimiento más frecuente: con 0,8/0,95/0,9 eran el 63 % del chat. Con
 * estos valores son ≈51 % (medido en 30 partidas), sin tocar victoria, tercer 6 ni puesto final.
 */
export const TRIGGER_CHANCE = {
  capture: 0.5,
  captureStreak: 0.7,
  badStreak: 0.65,
  thirdSix: 0.85,
  finishPlace: 0.9,
  goal: 0.65,
  ambient: 0.55,
} as const;

/** Probabilidad base de una réplica (se multiplica por las ganas de hablar de quien replica). */
export const REPLY_CHANCE = 0.5;
