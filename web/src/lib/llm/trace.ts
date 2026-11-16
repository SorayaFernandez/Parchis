// Trazabilidad mínima de las llamadas reales a AI Gateway (chat y movimientos): una línea por llamada con la
// operación, el origen final (`llm` o `local`), el modelo, la duración y, si se usó la frase o la jugada local,
// el motivo. Nunca el texto del modelo, el prompt, la clave ni identificadores de la partida.
//
// Solo se traza lo que llegó a llamar al modelo: el limitador global ya acota esas llamadas (4 por minuto entre
// chat y movimientos), y lo que se resolvió en local sin llamar ya lo registran los avisos limitados de cada
// flujo (`[chat] …`, `[move-llm] …`) y el resumen del limitador. Aun así, cada proceso escribe como mucho
// `MAX_TRACES_PER_MINUTE` líneas por minuto y, al empezar el minuto siguiente, cuántas omitió.

export type LlmOperation = "chat" | "movimiento";

export interface LlmTrace {
  operation: LlmOperation;
  /** Origen de lo que se usa al final: `llm` (la respuesta del modelo) o `local` (frase o jugada local). */
  source: "llm" | "local";
  model: string;
  durationMs: number;
  /** Motivo fijo de usar lo local (de las listas de motivos de cada flujo), nunca texto del modelo. */
  reason?: string;
  /** Movimientos: si la versión se guardó (con la reserva caducada, la decisión no se aplica). */
  saved?: boolean;
}

export const MAX_TRACES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** Solo letras, números y una puntuación mínima; sin comillas ni saltos de línea, y acotado. */
function clean(value: string, max: number): string {
  return value.replace(/[^\p{L}\p{N} .,:;()/_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function formatLlmTrace(trace: LlmTrace): string {
  const parts = [
    `operacion=${trace.operation}`,
    `origen=${trace.source}`,
    `modelo=${clean(trace.model, 80)}`,
    `duracion=${Math.max(0, Math.round(trace.durationMs))}ms`,
  ];
  if (trace.reason) parts.push(`motivo="${clean(trace.reason, 80)}"`);
  if (trace.saved !== undefined) parts.push(`guardado=${trace.saved ? "si" : "no"}`);
  return `[llm-trace] ${parts.join(" ")}`;
}

export interface TraceLogger {
  log(trace: LlmTrace): void;
}

/** Registrador con su propio tope por minuto (para las pruebas: reloj y salida inyectados). */
export function createTraceLogger(options: { now?: () => number; write?: (line: string) => void; maxPerMinute?: number } = {}): TraceLogger {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => console.info(line));
  const max = options.maxPerMinute ?? MAX_TRACES_PER_MINUTE;
  let windowStart = -Infinity;
  let written = 0;
  let dropped = 0;
  return {
    log(trace) {
      try {
        const t = now();
        if (t - windowStart >= WINDOW_MS) {
          if (dropped > 0) write(`[llm-trace] omitidas=${dropped} en el último minuto (tope de ${max} por proceso)`);
          windowStart = t;
          written = 0;
          dropped = 0;
        }
        if (written >= max) {
          dropped++;
          return;
        }
        written++;
        write(formatLlmTrace(trace));
      } catch {
        // La trazabilidad nunca afecta a la partida ni al chat.
      }
    },
  };
}

const shared = createTraceLogger();

/** Registra una llamada real a AI Gateway (compartido por todo el proceso). Nunca lanza. */
export function logLlmTrace(trace: LlmTrace): void {
  shared.log(trace);
}
