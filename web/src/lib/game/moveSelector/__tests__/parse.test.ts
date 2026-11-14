import { describe, expect, it } from "vitest";
import { setup } from "@/lib/engine/__tests__/helpers";
import { CHARACTER_IDS } from "@/lib/game/characters";
import { buildMoveDecision } from "../options";
import { MOVE_PARSE_REASONS, parseMoveChoice, topLevelKeys } from "../parse";

// Brava (pink) con un 3 y fichas en steps 20 y 30: opciones A (ficha 0) y B (ficha 1).
const state = { ...setup({ pink: [20, 30, -1, -1] }, CHARACTER_IDS), turn: CHARACTER_IDS[0], dice: 3 };
const decision = buildMoveDecision(state)!;
const parse = (content: unknown, finishReason: unknown = "stop") => parseMoveChoice({ content, finishReason }, decision);

describe("parseMoveChoice", () => {
  it("las opciones de la prueba son A → ficha 0 y B → ficha 1", () => {
    expect(decision.options.map((o) => [o.id, o.pieceIndex])).toEqual([["A", 0], ["B", 1]]);
  });

  it("JSON correcto: devuelve el identificador y su ficha (también con espacios o salto de línea en los extremos)", () => {
    expect(parse('{"choice":"B"}')).toEqual({ ok: true, id: "B", pieceIndex: 1 });
    expect(parse('  {"choice": "A"}\n')).toEqual({ ok: true, id: "A", pieceIndex: 0 });
    expect(parse('{"choice":"B"}', undefined)).toEqual({ ok: true, id: "B", pieceIndex: 1 });
  });

  it.each([
    ["JSON inválido", "{choice:B}", "JSON inválido"],
    ["comillas simples", "{'choice':'B'}", "JSON inválido"],
    ["dos objetos", '{"choice":"A"}{"choice":"B"}', "JSON inválido"],
    ["texto antes", 'Elijo {"choice":"B"}', "no es solo un objeto JSON"],
    ["texto después", '{"choice":"B"} porque captura', "no es solo un objeto JSON"],
    ["bloque Markdown", '```json\n{"choice":"B"}\n```', "no es solo un objeto JSON"],
    ["solo el identificador", "B", "no es solo un objeto JSON"],
    ["array", '[{"choice":"B"}]', "no es solo un objeto JSON"],
    ["clave adicional", '{"choice":"B","reason":"capturo"}', "formato no válido"],
    ["sin choice", '{"opcion":"B"}', "formato no válido"],
    ["choice numérico", '{"choice":1}', "formato no válido"],
    ["choice nulo", '{"choice":null}', "formato no válido"],
    ["identificador inexistente", '{"choice":"C"}', "opción inexistente"],
    ["minúscula (no se repara)", '{"choice":"b"}', "opción inexistente"],
    ["con espacios (no se recorta)", '{"choice":" B"}', "opción inexistente"],
    ["el pieceIndex en vez del identificador", '{"choice":"1"}', "opción inexistente"],
    ["clave duplicada con el mismo valor", '{"choice":"B","choice":"B"}', "clave duplicada"],
    ["clave duplicada con otro valor", '{"choice":"A","choice":"B"}', "clave duplicada"],
    ["clave duplicada con un valor inexistente", '{"choice":"Z","choice":"A"}', "clave duplicada"],
    ["clave duplicada escrita con escapes", '{"choice":"A","\\u0063hoice":"B"}', "clave duplicada"],
    ["clave duplicada con otra clave entre medias", '{"choice":"A","x":1,"choice":"A"}', "clave duplicada"],
    ["respuesta vacía", "", "respuesta sin texto"],
    ["solo espacios", "   \n", "respuesta sin texto"],
  ])("%s → rechazo", (_, content, reason) => {
    expect(parse(content)).toEqual({ ok: false, reason });
  });

  it("claves duplicadas: solo cuentan las del objeto exterior, no los valores ni los objetos anidados", () => {
    // «choice» como valor o dentro de un objeto anidado no es una clave repetida.
    expect(parse('{"choice":"choice"}')).toEqual({ ok: false, reason: "opción inexistente" });
    expect(parse('{"choice":"A","x":{"choice":"B"}}')).toEqual({ ok: false, reason: "formato no válido" });
    expect(topLevelKeys('{"choice":"A","x":{"choice":"B","y":["choice"]}}')).toEqual(["choice", "x"]);
    // Comillas y barras escapadas dentro de un valor no confunden el recorrido.
    expect(topLevelKeys('{"choice":"A\\"\\\\","choice":"B"}')).toEqual(["choice", "choice"]);
    expect(topLevelKeys('{"\\u0063hoice":"A"}')).toEqual(["choice"]);
    expect(topLevelKeys(' { "choice" : "A" } ')).toEqual(["choice"]);
  });

  it("las secuencias de escape del valor se aceptan como el identificador que representan", () => {
    expect(parse('{"choice":"\\u0042"}')).toEqual({ ok: true, id: "B", pieceIndex: 1 });
  });

  it("contenido que no es texto: rechazo", () => {
    for (const content of [null, undefined, 42, { choice: "B" }, [{ type: "text", text: '{"choice":"B"}' }]]) {
      expect(parse(content)).toEqual({ ok: false, reason: "respuesta sin texto" });
    }
  });

  it("finish_reason «length»: truncada, aunque el texto parezca válido", () => {
    expect(parse('{"choice":"B"}', "length")).toEqual({ ok: false, reason: "respuesta truncada" });
    expect(parse('{"choice":"B', "length")).toEqual({ ok: false, reason: "respuesta truncada" });
  });

  it("los motivos son textos fijos, sin el contenido del modelo", () => {
    const secret = '{"choice":"Z","x":"texto secreto"}';
    const result = parse(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(MOVE_PARSE_REASONS).toContain(result.reason);
      expect(result.reason).not.toContain("secreto");
    }
  });
});
