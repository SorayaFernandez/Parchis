import { describe, expect, it } from "vitest";
import { MOVES_LLM } from "../config";
import { readMoveLlmConfig } from "../env";

const KEY = "clave-secreta-de-prueba-123";
const PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview" };
const valid = { ...PREVIEW, MOVES_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, MOVES_LLM_MODEL: MOVES_LLM.model };

describe("readMoveLlmConfig", () => {
  it("el único modelo es el acordado, con su identificador exacto", () => {
    expect(MOVES_LLM.model).toBe("nvidia/nemotron-3.5-lightning-free");
    expect(MOVES_LLM.timeoutMs).toBe(3_000);
  });

  it("configuración válida en Preview: activo, con la clave y el modelo", () => {
    expect(readMoveLlmConfig(valid)).toEqual({ enabled: true, apiKey: KEY, model: MOVES_LLM.model, provider: null });
    expect(readMoveLlmConfig({ ...valid, MOVES_LLM_PROVIDER: "nvidia" })).toMatchObject({ enabled: true, provider: "nvidia" });
  });

  it("desactivado salvo MOVES_LLM_ENABLED=true (independiente del chat)", () => {
    for (const value of [undefined, "", "false", "1", "yes"]) {
      expect(readMoveLlmConfig({ ...valid, MOVES_LLM_ENABLED: value })).toEqual({ enabled: false, reason: "off" });
    }
    // Activar el chat no activa los movimientos.
    expect(readMoveLlmConfig({ ...PREVIEW, CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, CHAT_LLM_MODEL: MOVES_LLM.model })).toEqual({ enabled: false, reason: "off" });
  });

  it("solo en Vercel Preview: Production, Development, otros valores, sin VERCEL_ENV o fuera de Vercel → not_preview", () => {
    for (const env of [
      { VERCEL: "1", VERCEL_ENV: "production" },
      { VERCEL: "1", VERCEL_ENV: "development" },
      { VERCEL: "1", VERCEL_ENV: "Preview" },
      { VERCEL: "1", VERCEL_ENV: "preview " },
      { VERCEL: "1" },
      { VERCEL_ENV: "preview" },
      {},
    ]) {
      expect(readMoveLlmConfig({ MOVES_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, MOVES_LLM_MODEL: MOVES_LLM.model, ...env }), JSON.stringify(env)).toEqual({
        enabled: false,
        reason: "not_preview",
      });
    }
  });

  it("configuración incorrecta: falta la clave o el modelo, modelo distinto o proveedor no válido", () => {
    expect(readMoveLlmConfig({ ...valid, AI_GATEWAY_API_KEY: "  " })).toEqual({ enabled: false, reason: "missing_key" });
    expect(readMoveLlmConfig({ ...valid, MOVES_LLM_MODEL: undefined })).toEqual({ enabled: false, reason: "missing_model" });
    for (const model of ["openai/gpt-4o", "nvidia/nemotron-3.5-lightning", "NVIDIA/nemotron-3.5-lightning-free", "nvidia/nemotron-3.5-lightning-free:paid"]) {
      expect(readMoveLlmConfig({ ...valid, MOVES_LLM_MODEL: model }), model).toEqual({ enabled: false, reason: "model_not_allowed" });
    }
    expect(readMoveLlmConfig({ ...valid, MOVES_LLM_PROVIDER: "Nvidia AI" })).toEqual({ enabled: false, reason: "invalid_provider" });
  });

  it("una clave con prefijo público desactiva el selector aunque no se haya pedido activarlo", () => {
    expect(readMoveLlmConfig({ ...valid, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY })).toEqual({ enabled: false, reason: "public_secret" });
    expect(readMoveLlmConfig({ NEXT_PUBLIC_MOVES_LLM_API_KEY: KEY })).toEqual({ enabled: false, reason: "public_secret" });
  });

  it("ningún resultado desactivado contiene la clave", () => {
    for (const env of [{ ...valid, MOVES_LLM_MODEL: "x" }, { ...valid, VERCEL_ENV: "production" }, { ...valid, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY }]) {
      expect(JSON.stringify(readMoveLlmConfig(env))).not.toContain(KEY);
    }
  });
});
