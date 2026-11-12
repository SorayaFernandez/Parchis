import { describe, expect, it } from "vitest";
import { CHARACTERS } from "@/lib/game/characters";
import { addCatchphrases, detectCatchphrases } from "../catchphrases";

const [BRAVA, ERNESTO, PILAR, CHISPA] = ["ai-pink", "ai-purple", "ai-green", "ai-blue"];

describe("detección de coletillas (compartida por el director, el escritor local y el validador)", () => {
  it("cada personaje: sus tres coletillas, por su índice en `catchphrases`", () => {
    for (const c of CHARACTERS) {
      c.catchphrases.forEach((phrase, index) => expect(detectCatchphrases(c.id, phrase), `${c.name}: ${phrase}`).toEqual([index]));
    }
  });

  it("variantes al inicio de una frase cuentan; dentro de otra frase, no", () => {
    expect(detectCatchphrases(BRAVA, "¡A casa con eso, Chispa!")).toEqual([0]);
    expect(detectCatchphrases(BRAVA, "¡A casa, Don Ernesto! ¿Quién es el siguiente?")).toEqual([0, 1]);
    expect(detectCatchphrases(BRAVA, "Vuelve a casa, Chispa.")).toEqual([]);
    expect(detectCatchphrases(BRAVA, "Esa ficha va a casa, Chispa.")).toEqual([]);
    expect(detectCatchphrases(PILAR, "Despacito y buena letra, hijito, que la paciencia gana.")).toEqual([0]);
    expect(detectCatchphrases(PILAR, "Ay, hijo, qué partida más larga. Despacito y buena letra.")).toEqual([0]);
    expect(detectCatchphrases(ERNESTO, "Previsible: su captura confirma la ley de probabilidades.")).toEqual([0]);
    expect(detectCatchphrases(ERNESTO, "Era imprevisible, lo admito.")).toEqual([]);
  });

  it("solo las de quien habla: las coletillas de otros personajes y las palabras comunes no cuentan", () => {
    expect(detectCatchphrases(CHISPA, "¡A casa, Brava!")).toEqual([]);
    expect(detectCatchphrases(BRAVA, "Previsible, señores.")).toEqual([]);
    expect(detectCatchphrases(CHISPA, "Hoy es mi día, señores.")).toEqual([1]);
    expect(detectCatchphrases(CHISPA, "Hoy no es mi día.")).toEqual([]);
    expect(detectCatchphrases("ai-nadie", "¡A casa!")).toEqual([]);
  });

  it("addCatchphrases: sin duplicados, en orden y acotado", () => {
    expect(addCatchphrases([0], [0, 2], 10)).toEqual([0, 2]);
    expect(addCatchphrases([], [], 10)).toEqual([]);
    expect(addCatchphrases([0, 1, 2], [3], 3)).toEqual([1, 2, 3]);
  });
});
