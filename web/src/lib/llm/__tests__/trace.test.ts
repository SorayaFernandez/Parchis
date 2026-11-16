import { describe, expect, it } from "vitest";
import { createTraceLogger, formatLlmTrace, MAX_TRACES_PER_MINUTE } from "../trace";

const MODEL = "nvidia/nemotron-3.5-lightning-free";

describe("trazabilidad de las llamadas a AI Gateway", () => {
  it("una línea con la operación, el origen, el modelo, la duración y, si hay, el motivo y si se guardó", () => {
    expect(formatLlmTrace({ operation: "chat", source: "llm", model: MODEL, durationMs: 812.4 })).toBe(
      `[llm-trace] operacion=chat origen=llm modelo=${MODEL} duracion=812ms`,
    );
    expect(formatLlmTrace({ operation: "movimiento", source: "local", model: MODEL, durationMs: 3001, reason: "fallo del selector: respuesta truncada", saved: true })).toBe(
      `[llm-trace] operacion=movimiento origen=local modelo=${MODEL} duracion=3001ms motivo="fallo del selector: respuesta truncada" guardado=si`,
    );
    expect(formatLlmTrace({ operation: "movimiento", source: "llm", model: MODEL, durationMs: -5, saved: false })).toContain("duracion=0ms guardado=no");
  });

  it("sanea el motivo y el modelo: sin comillas, saltos de línea ni texto largo", () => {
    const line = formatLlmTrace({ operation: "chat", source: "local", model: `${MODEL}"\nx`, durationMs: 1, reason: `motivo "con" comillas\ny salto ${"x".repeat(200)}` });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.match(/"/g)).toHaveLength(2); // solo las que envuelven el motivo
    expect(line.length).toBeLessThan(260);
  });

  it(`como mucho ${MAX_TRACES_PER_MINUTE} líneas por minuto; al minuto siguiente dice cuántas omitió`, () => {
    const lines: string[] = [];
    let t = 0;
    const logger = createTraceLogger({ now: () => t, write: (l) => lines.push(l), maxPerMinute: 3 });
    for (let i = 0; i < 5; i++) logger.log({ operation: "chat", source: "llm", model: MODEL, durationMs: i });
    expect(lines).toHaveLength(3);
    t += 60_000;
    logger.log({ operation: "movimiento", source: "llm", model: MODEL, durationMs: 1 });
    expect(lines.slice(3)).toEqual([
      "[llm-trace] omitidas=2 en el último minuto (tope de 3 por proceso)",
      `[llm-trace] operacion=movimiento origen=llm modelo=${MODEL} duracion=1ms`,
    ]);
  });

  it("nunca lanza, aunque falle la salida", () => {
    const logger = createTraceLogger({ write: () => { throw new Error("salida rota"); } });
    expect(() => logger.log({ operation: "chat", source: "llm", model: MODEL, durationMs: 1 })).not.toThrow();
  });
});
