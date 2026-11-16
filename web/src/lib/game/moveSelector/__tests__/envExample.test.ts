// F5: `web/.env.example` documenta las variables del selector de movimientos de forma coherente con
// `readMoveLlmConfig` y el cupo. Se lee el archivo real (sin secretos: solo valores de ejemplo).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MOVES_LLM } from "../config";
import { readMoveLlmConfig } from "../env";
import { getGatewayLimiter } from "@/lib/llm/gatewayLimiter";
import { MOVES_LLM_QUOTA } from "../quota";

vi.mock("server-only", () => ({}));

const TEMPLATE = readFileSync(fileURLToPath(new URL("../../../../../.env.example", import.meta.url)), "utf8");

/** Variables del ejemplo (comentadas o no): la primera aparición de cada nombre, sin el comentario final. */
function exampleVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of TEMPLATE.split("\n")) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=(\S*)/.exec(line);
    if (match && !(match[1] in vars)) vars[match[1]] = match[2];
  }
  return vars;
}

const vars = exampleVars();
/** Lo que habría en Preview con el ejemplo, tras poner MOVES_LLM_ENABLED=true y las credenciales de Upstash. */
const previewWithExample: Record<string, string | undefined> = {
  ...vars,
  MOVES_LLM_ENABLED: "true",
  VERCEL: "1",
  VERCEL_ENV: "preview",
};

describe("web/.env.example: selector de movimientos", () => {
  it("documenta las variables propias con el modelo exacto y desactivado por defecto", () => {
    expect(vars.MOVES_LLM_ENABLED).toBe("false");
    expect(vars.MOVES_LLM_MODEL).toBe("nvidia/nemotron-3.5-lightning-free");
    expect(vars.MOVES_LLM_MODEL).toBe(MOVES_LLM.model);
    expect("MOVES_LLM_PROVIDER" in vars).toBe(true);
    // La clave es la del chat (una sola AI_GATEWAY_API_KEY) y Upstash, las del limitador.
    expect(TEMPLATE.match(/^#?\s*AI_GATEWAY_API_KEY=/gm)).toHaveLength(1);
    for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) expect(name in vars, name).toBe(true);
    expect(TEMPLATE).toContain("KV_REST_API_URL/KV_REST_API_TOKEN");
  });

  it("con el ejemplo en Vercel Preview y MOVES_LLM_ENABLED=true, el selector se activa y hay cupo", () => {
    expect(readMoveLlmConfig(previewWithExample)).toMatchObject({ enabled: true, model: MOVES_LLM.model, provider: null });
    expect(getGatewayLimiter(previewWithExample)).not.toBeNull();
  });

  it("Production (y Development o local) sigue desactivado aunque estén todas las variables", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, { VERCEL: undefined, VERCEL_ENV: undefined }]) {
      expect(readMoveLlmConfig({ ...previewWithExample, ...env }), JSON.stringify(env)).toEqual({ enabled: false, reason: "not_preview" });
    }
  });

  it("sin Upstash no hay cupo (y la ruta no crea el selector)", () => {
    const withoutUpstash = { ...previewWithExample, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined };
    expect(readMoveLlmConfig(withoutUpstash).enabled).toBe(true);
    expect(getGatewayLimiter(withoutUpstash)).toBeNull();
  });

  it("las variables del chat no activan por sí solas el selector", () => {
    const chatOnly = { VERCEL: "1", VERCEL_ENV: "preview", CHAT_LLM_ENABLED: "true", AI_GATEWAY_API_KEY: vars.AI_GATEWAY_API_KEY, CHAT_LLM_MODEL: vars.CHAT_LLM_MODEL };
    expect(readMoveLlmConfig(chatOnly)).toEqual({ enabled: false, reason: "off" });
  });

  it("sin secretos ni NEXT_PUBLIC_ para claves; el timeout y el cupo no son variables", () => {
    expect(Object.keys(vars).filter((n) => n.startsWith("NEXT_PUBLIC_"))).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
    expect(vars.AI_GATEWAY_API_KEY).toMatch(/^EJEMPLO_/);
    expect(vars.UPSTASH_REDIS_REST_TOKEN).toMatch(/^EJEMPLO_/);
    expect(Object.keys(vars).some((n) => /MOVES_LLM_(TIMEOUT|LIMIT|QUOTA)/.test(n))).toBe(false);
    expect(MOVES_LLM.timeoutMs).toBe(3_000);
    expect(MOVES_LLM_QUOTA.limit).toBe(20);
  });
});
