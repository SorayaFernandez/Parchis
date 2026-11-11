import { describe, expect, it } from "vitest";
import { CHAT_LLM } from "../../config";
import { readChatLlmConfig } from "../env";

const MODEL = "nvidia/nemotron-3.5-lightning-free";
const KEY = "clave-secreta-de-prueba-123";
const ok = { CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: KEY, CHAT_LLM_MODEL: MODEL };

describe("readChatLlmConfig", () => {
  it("el modelo de la fase 8.2b es el único permitido", () => {
    expect(CHAT_LLM.allowedModels).toEqual([MODEL]);
  });

  it("configuración válida → activo, con la clave y el modelo", () => {
    expect(readChatLlmConfig(ok)).toEqual({ enabled: true, apiKey: KEY, model: MODEL, provider: null });
    expect(readChatLlmConfig({ ...ok, CHAT_LLM_ENABLED: " TRUE ", AI_GATEWAY_API_KEY: ` ${KEY} ` })).toMatchObject({ enabled: true, apiKey: KEY });
    expect(readChatLlmConfig({ ...ok, CHAT_LLM_PROVIDER: "nvidia" })).toMatchObject({ enabled: true, provider: "nvidia" });
  });

  it("desactivado salvo CHAT_LLM_ENABLED=true (no se activa por tener la clave)", () => {
    expect(readChatLlmConfig({})).toEqual({ enabled: false, reason: "off" });
    for (const value of [undefined, "", "false", "1", "yes", "on"]) {
      expect(readChatLlmConfig({ ...ok, CHAT_LLM_ENABLED: value })).toEqual({ enabled: false, reason: "off" });
    }
  });

  it("configuración incompleta o no válida → desactivado con el motivo, sin el valor", () => {
    expect(readChatLlmConfig({ ...ok, AI_GATEWAY_API_KEY: "  " })).toEqual({ enabled: false, reason: "missing_key" });
    expect(readChatLlmConfig({ ...ok, CHAT_LLM_MODEL: undefined })).toEqual({ enabled: false, reason: "missing_model" });
    expect(readChatLlmConfig({ ...ok, CHAT_LLM_PROVIDER: "Nvidia; DROP" })).toEqual({ enabled: false, reason: "invalid_provider" });
  });

  it("modelo no permitido (p. ej. uno de pago) → desactivado", () => {
    for (const model of ["openai/gpt-5", "nvidia/nemotron-3.5-lightning", "NVIDIA/NEMOTRON-3.5-LIGHTNING-FREE"]) {
      expect(readChatLlmConfig({ ...ok, CHAT_LLM_MODEL: model })).toEqual({ enabled: false, reason: "model_not_allowed" });
    }
  });

  it("una clave con prefijo NEXT_PUBLIC_ desactiva el LLM aunque esté activado", () => {
    expect(readChatLlmConfig({ ...ok, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY })).toEqual({ enabled: false, reason: "public_secret" });
    expect(readChatLlmConfig({ NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY })).toEqual({ enabled: false, reason: "public_secret" });
  });

  it("en Vercel solo se activa en Preview", () => {
    expect(readChatLlmConfig({ ...ok, VERCEL: "1", VERCEL_ENV: "preview" })).toMatchObject({ enabled: true, model: MODEL });
    expect(readChatLlmConfig({ ...ok, VERCEL: "1", VERCEL_ENV: "preview", CHAT_LLM_PROVIDER: "nvidia" })).toMatchObject({ enabled: true, provider: "nvidia" });
  });

  it("en Vercel Production, Development u otro valor queda desactivado", () => {
    for (const value of ["production", "development", "Preview", " preview", "staging", ""]) {
      expect(readChatLlmConfig({ ...ok, VERCEL: "1", VERCEL_ENV: value })).toEqual({ enabled: false, reason: "not_preview" });
    }
  });

  it("en Vercel sin VERCEL_ENV queda desactivado (falla cerrado)", () => {
    expect(readChatLlmConfig({ ...ok, VERCEL: "1" })).toEqual({ enabled: false, reason: "not_preview" });
  });

  it("en Production sin activarlo sigue siendo `off` (no se registra como error)", () => {
    expect(readChatLlmConfig({ VERCEL: "1", VERCEL_ENV: "production" })).toEqual({ enabled: false, reason: "off" });
  });

  it("fuera de Vercel (desarrollo local) se activa con la configuración válida, sin depender de VERCEL_ENV", () => {
    expect(readChatLlmConfig(ok)).toMatchObject({ enabled: true });
    expect(readChatLlmConfig({ ...ok, NODE_ENV: "development" })).toMatchObject({ enabled: true });
    expect(readChatLlmConfig({ ...ok, VERCEL_ENV: "production" })).toMatchObject({ enabled: true }); // sin VERCEL=1
  });

  it("en Preview se mantienen las demás comprobaciones (modelo permitido y clave pública)", () => {
    const preview = { ...ok, VERCEL: "1", VERCEL_ENV: "preview" };
    expect(readChatLlmConfig({ ...preview, CHAT_LLM_MODEL: "openai/gpt-5" })).toEqual({ enabled: false, reason: "model_not_allowed" });
    expect(readChatLlmConfig({ ...preview, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY })).toEqual({ enabled: false, reason: "public_secret" });
    expect(readChatLlmConfig({ ...preview, AI_GATEWAY_API_KEY: "" })).toEqual({ enabled: false, reason: "missing_key" });
  });

  it("el resultado de un error nunca contiene la clave", () => {
    for (const env of [{ ...ok, CHAT_LLM_MODEL: "otro/modelo" }, { ...ok, NEXT_PUBLIC_AI_GATEWAY_API_KEY: KEY }, { ...ok, VERCEL: "1", VERCEL_ENV: "production" }]) {
      expect(JSON.stringify(readChatLlmConfig(env))).not.toContain(KEY);
    }
  });
});
