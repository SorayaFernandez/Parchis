// Limitador global de llamadas al modelo de AI Gateway (Nemotron), compartido por el chat y el selector
// de movimientos. Módulo puro: solo los scripts Lua, los nombres de las claves y los límites. Lo usan el
// cliente (`gatewayLimiter.ts`, sobre Upstash) y las pruebas contra Redis real (Docker).
//
// El proveedor limita a 5 peticiones por minuto para todo el equipo (en cada región y entre todas). Aquí:
// como mucho 4 por ventana deslizante de 60 s entre los dos consumidores, y 2 por consumidor. Además, el
// cupo de 20 consultas por partida del selector de movimientos se comprueba y se consume en la MISMA
// operación atómica, así que una petición denegada por el límite global no gasta cupo de la partida.
//
// Claves (independientes del entorno, porque el límite es del equipo; con la etiqueta `{parchis-llm}` para
// que un EVAL con varias claves las tenga en el mismo slot):
// - ventana: sorted set con un miembro `<consumidor>:<id de la concesión>` por llamada concedida y su
//   instante (ms) como puntuación;
// - bloqueo: instante (ms) hasta el que no se llama a nadie tras un 429 del proveedor;
// - cupo de una partida: contador de consultas de movimientos (caduca a los 7 días de la primera);
// - concesión de movimientos: marca de cada consulta concedida, para devolverla una sola vez si el
//   proveedor responde 429 (caduca antes que el contador de su partida).
// En Redis solo hay ids aleatorios, instantes y contadores: ni prompts, ni mensajes, ni IP.

export type LlmConsumer = "chat" | "moves";

export const LLM_GATEWAY_LIMITS = {
  /** Llamadas concedidas como mucho en cualquier ventana de `windowMs` (el proveedor admite 5). */
  globalLimit: 4,
  /** Llamadas como mucho de cada consumidor (chat, movimientos) en la misma ventana. */
  consumerLimit: 2,
  windowMs: 60_000,
  /** Consultas al selector de movimientos por partida. */
  movesPerGame: 20,
  /** Caducidad del cupo de una partida desde su primera consulta. */
  movesQuotaTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Vida máxima de la marca de una concesión de movimientos (para la devolución ante un 429). */
  grantTtlMs: 60 * 60 * 1000,
  /** Bloqueo tras un 429 sin `Retry-After` válido, y máximo que se respeta de un `Retry-After`. */
  defaultBlockMs: 60_000,
  maxBlockMs: 60 * 60 * 1000,
  /** Más tiempo que esto sin respuesta de Redis se trata como no disponible. */
  redisTimeoutMs: 1_000,
} as const;

const TAG = "{parchis-llm}";
export const LIMITER_KEYS = {
  window: `${TAG}:gateway:window`,
  blocked: `${TAG}:gateway:blocked-until`,
  movesQuota: (gameId: string) => `${TAG}:moves-quota:${gameId}`,
  movesGrant: (grantId: string) => `${TAG}:moves-grant:${grantId}`,
} as const;

/** Códigos que devuelve `ACQUIRE_SCRIPT` (enteros). */
export const ACQUIRE_CODES = {
  /** Concedida al chat (sin cupo por partida). */
  allowedChat: 0,
  /** Bloqueo global vigente tras un 429. */
  blocked: -1,
  /** Ya hay `globalLimit` llamadas en la ventana. */
  globalLimited: -2,
  /** Este consumidor ya tiene `consumerLimit` llamadas en la ventana. */
  consumerLimited: -3,
  /** La partida ya ha hecho sus 20 consultas. */
  quotaExhausted: -4,
  // 1…movesPerGame: concedida a movimientos; es la consulta número N de la partida.
} as const;

/** Hora del servidor de Redis (igual para todas las instancias); si no se puede leer, la del cliente. */
const NOW = `
local now
local ok, t = pcall(redis.call, 'TIME')
if ok and type(t) == 'table' then
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
else
  now = tonumber(ARGV[3])
end
`;

/**
 * Concede (o no) una llamada, de forma atómica. Comprueba en este orden: bloqueo global, límite global de
 * la ventana, límite del consumidor y, solo para movimientos, el cupo de la partida. Si todo pasa, añade la
 * llamada a la ventana y, para movimientos, incrementa el cupo y marca la concesión. Si algo falla, no
 * cambia nada (una denegación global no gasta cupo; un cupo agotado no ocupa la ventana).
 * KEYS: ventana, bloqueo[, cupo de la partida, marca de la concesión]
 * ARGV: consumidor, id de la concesión, hora del cliente (ms), límite global, límite por consumidor,
 *       ventana (ms), cupo por partida, caducidad del cupo (ms), vida de la marca (ms)
 */
export const ACQUIRE_SCRIPT = `${NOW}
local consumer = ARGV[1]
local blocked = tonumber(redis.call('GET', KEYS[2]) or '0')
if blocked > now then return ${ACQUIRE_CODES.blocked} end
local windowMs = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local entries = redis.call('ZRANGE', KEYS[1], 0, -1)
if #entries >= tonumber(ARGV[4]) then return ${ACQUIRE_CODES.globalLimited} end
local mine = 0
local prefix = consumer .. ':'
for _, member in ipairs(entries) do
  if string.sub(member, 1, #prefix) == prefix then mine = mine + 1 end
end
if mine >= tonumber(ARGV[5]) then return ${ACQUIRE_CODES.consumerLimited} end
local result = ${ACQUIRE_CODES.allowedChat}
if #KEYS >= 4 then
  local used = tonumber(redis.call('GET', KEYS[3]) or '0')
  if used >= tonumber(ARGV[7]) then return ${ACQUIRE_CODES.quotaExhausted} end
  used = redis.call('INCR', KEYS[3])
  if used == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[8]) end
  local ttl = redis.call('PTTL', KEYS[3])
  local grantTtl = tonumber(ARGV[9])
  if ttl > 0 and ttl < grantTtl then grantTtl = ttl end
  redis.call('SET', KEYS[4], '1', 'PX', grantTtl)
  result = used
end
redis.call('ZADD', KEYS[1], now, prefix .. ARGV[2])
redis.call('PEXPIRE', KEYS[1], windowMs)
return result
`;

/**
 * Bloqueo global tras un 429: nadie llama hasta `ahora + duración`. Nunca acorta un bloqueo más largo ya
 * vigente. Devuelve 1 si lo amplía y 0 si ya había uno igual o más largo.
 * KEYS: bloqueo · ARGV: duración (ms), (sin uso), hora del cliente (ms)
 */
export const BLOCK_SCRIPT = `${NOW}
local untilTs = now + tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilTs <= current then return 0 end
redis.call('SET', KEYS[1], untilTs, 'PX', ARGV[1])
return 1
`;

/**
 * Devolución de UNA concesión de movimientos cuando el proveedor responde 429: solo si su marca existe (la
 * borra, así que como mucho una vez por concesión), y solo si el contador de la partida sigue vivo y es
 * mayor que 0. No toca la ventana global. Devuelve 1 si devuelve y 0 si no.
 * KEYS: cupo de la partida, marca de la concesión
 */
export const REFUND_SCRIPT = `
if redis.call('DEL', KEYS[2]) == 0 then return 0 end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used <= 0 then return 0 end
redis.call('DECR', KEYS[1])
return 1
`;
