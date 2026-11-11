import { describe, expect, it } from "vitest";
import { SupabaseEnvError, parsePublicSupabaseEnv, parseServerSupabaseEnv } from "../env";

// Valores ficticios (mismo formato que los reales).
const URL = "https://ejemplo.supabase.co";
const PUBLISHABLE = "sb_publishable_FICTICIA123";
const SECRET = "sb_secret_FICTICIA456";

const full = {
  NEXT_PUBLIC_SUPABASE_URL: URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  SUPABASE_SECRET_KEY: SECRET,
};

function errorOf(fn: () => unknown): SupabaseEnvError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SupabaseEnvError) return error;
    throw error;
  }
  throw new Error("Se esperaba un SupabaseEnvError");
}

describe("variables públicas", () => {
  it("acepta URL y clave publicable", () => {
    expect(parsePublicSupabaseEnv(full)).toEqual({ url: URL, publishableKey: PUBLISHABLE });
  });

  it("indica qué variables faltan", () => {
    const error = errorOf(() => parsePublicSupabaseEnv({}));
    expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_URL: falta");
    expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: falta");
  });

  it("rechaza una URL con ruta (p. ej. la del endpoint REST), sin mostrar su valor", () => {
    for (const url of [`${URL}/rest/v1/`, `${URL}/rest/v1`, `${URL}/algo`, `${URL}/?x=1`]) {
      const error = errorOf(() =>
        parsePublicSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }),
      );
      expect(error.message).toContain("sin ruta");
      expect(error.message).not.toContain("ejemplo.supabase.co");
    }
    // Con o sin barra final es válida.
    expect(parsePublicSupabaseEnv({ ...full, NEXT_PUBLIC_SUPABASE_URL: `${URL}/` }).url).toBe(`${URL}/`);
  });

  it("rechaza una URL inválida y una clave que no es publicable, sin mostrar su valor", () => {
    const error = errorOf(() =>
      parsePublicSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "no-es-url", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SECRET }),
    );
    expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(error.message).toContain('debe empezar por "sb_publishable_"');
    expect(error.message).not.toContain(SECRET);
  });
});

describe("variables del servidor", () => {
  it("acepta las tres variables", () => {
    expect(parseServerSupabaseEnv(full)).toEqual({ url: URL, publishableKey: PUBLISHABLE, secretKey: SECRET });
  });

  it("exige la clave secreta con su formato, sin mostrar su valor", () => {
    expect(errorOf(() => parseServerSupabaseEnv({ ...full, SUPABASE_SECRET_KEY: undefined })).message).toContain(
      "SUPABASE_SECRET_KEY: falta",
    );
    const error = errorOf(() => parseServerSupabaseEnv({ ...full, SUPABASE_SECRET_KEY: PUBLISHABLE }));
    expect(error.message).toContain('debe empezar por "sb_secret_"');
    expect(error.message).not.toContain(PUBLISHABLE);
  });

  it("se niega a usar una clave secreta puesta en una variable NEXT_PUBLIC_", () => {
    const error = errorOf(() => parseServerSupabaseEnv({ ...full, NEXT_PUBLIC_SUPABASE_SECRET_KEY: SECRET }));
    expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_SECRET_KEY");
    expect(error.message).not.toContain(SECRET);
  });
});

describe("protección del cliente de servidor", () => {
  it("server.ts no se puede importar fuera del servidor (server-only)", async () => {
    await expect(import("../server")).rejects.toThrow("cannot be imported from a Client Component");
  });
});
