import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@/lib/engine";
import { CHARACTER_IDS } from "@/lib/game/characters";

vi.mock("server-only", () => ({}));

// El repositorio real se sustituye por uno falso: aquí se prueba solo el endpoint.
const create = vi.fn();
vi.mock("@/lib/game/repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/repository")>();
  return { ...original, getGamesRepository: () => ({ create, get: vi.fn() }) };
});

const { POST } = await import("../route");
const { GameRepositoryError } = await import("@/lib/game/repository");
const { SupabaseEnvError } = await import("@/lib/supabase/env");

const ID = "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f";
const post = (body?: string) => POST(new Request("http://localhost/api/games", { method: "POST", body, headers: { "Content-Type": "application/json" } }));

describe("POST /api/games", () => {
  beforeEach(() => {
    create.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("CSRF: acepta la propia aplicación; 403 con un origen externo o cross-site y 415 sin JSON, sin crear nada", async () => {
    create.mockImplementation(async (state) => ({ id: ID, version: 1, state }));
    const send = (headers: Record<string, string>, body = "{}") =>
      POST(new Request("http://localhost/api/games", { method: "POST", body, headers }));
    const own = await send({ "Content-Type": "application/json", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" });
    expect(own.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    create.mockClear();
    const cases: [Record<string, string>, number, string][] = [
      [{ "Content-Type": "application/json", Origin: "https://evil.example" }, 403, "forbidden_origin"],
      [{ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, 403, "forbidden_origin"],
      [{ "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, 403, "forbidden_origin"],
      [{ "Content-Type": "text/plain", Origin: "http://localhost" }, 415, "unsupported_media_type"],
      [{}, 415, "unsupported_media_type"], // un cuerpo de texto sin tipo llega como text/plain
    ];
    for (const [headers, status, code] of cases) {
      const response = await send(headers);
      expect(response.status, JSON.stringify(headers)).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe(code);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("crea la partida con los cuatro personajes y devuelve 201 { id, version }", async () => {
    create.mockImplementation(async (state) => ({ id: ID, version: 1, state }));
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: ID, version: 1 });
    expect(create).toHaveBeenCalledWith(createGame([...CHARACTER_IDS]));
  });

  it("acepta {} como cuerpo", async () => {
    create.mockResolvedValue({ id: ID, version: 1 });
    expect((await post("{}")).status).toBe(201);
  });

  it("rechaza parámetros o cuerpos que no son JSON (400) sin crear nada", async () => {
    for (const body of ['{"players":["x"]}', "no-json", "[]"]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_body");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("error de base de datos: 503 con mensaje genérico", async () => {
    create.mockRejectedValue(new GameRepositoryError("database", "Error de base de datos al crear la partida", "42501"));
    const response = await post();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("storage_unavailable");
    expect(JSON.stringify(body)).not.toContain("42501");
  });

  it("configuración incorrecta: 500 sin detalles", async () => {
    create.mockRejectedValue(new SupabaseEnvError("SUPABASE_SECRET_KEY: falta"));
    const response = await post();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("server_misconfigured");
    expect(JSON.stringify(body)).not.toContain("SUPABASE_SECRET_KEY");
  });
});
