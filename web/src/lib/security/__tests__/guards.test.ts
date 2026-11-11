// Endpoints con límite: camino completo (ruta → guard → limitador → adaptador de Upstash), con
// @upstash/ratelimit simulado, más compatibilidad con espectadores reales (limitador de prueba).

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGame } from "@/lib/engine";
import { CHARACTER_IDS } from "@/lib/game/characters";

vi.mock("server-only", () => ({}));

// Upstash simulado: cuenta por identificador con el límite de la regla. `providerDown` simula fallos.
const counts = new Map<string, number>();
let providerDown = false;
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow(limit: number, window: string) {
      return { limit, windowSec: Number.parseInt(window) };
    }
    private readonly cfg: { limit: number; windowSec: number };
    constructor(options: { limiter: { limit: number; windowSec: number } }) {
      this.cfg = options.limiter;
    }
    async limit(identifier: string) {
      if (providerDown) throw new Error("upstash caído");
      const n = (counts.get(identifier) ?? 0) + 1;
      counts.set(identifier, n);
      return { success: n <= this.cfg.limit, reset: Date.now() + this.cfg.windowSec * 1000, remaining: 0, limit: this.cfg.limit, pending: Promise.resolve() };
    }
  },
}));

// Repositorio y servicio de avance simulados: aquí solo interesa el límite.
const create = vi.fn(async (state: unknown) => ({ id: "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f", version: 1, state }));
const get = vi.fn(async () => null);
vi.mock("@/lib/game/repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/repository")>();
  return { ...original, getGamesRepository: () => ({ create, get }) };
});
const advanceGame = vi.fn(async () => ({ kind: "turn_in_progress" as const }));
vi.mock("@/lib/game/advance", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/game/advance")>();
  return { ...original, advanceGame: (...args: unknown[]) => advanceGame(...(args as [])) };
});

vi.stubEnv("VERCEL", "1");
vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://ejemplo-ficticio.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token-ficticio-solo-pruebas");
afterAll(() => vi.unstubAllEnvs());

const { POST: createGameRoute } = await import("@/app/api/games/route");
const { GET: getGameRoute } = await import("@/app/api/games/[id]/route");
const { POST: advanceRoute } = await import("@/app/api/games/[id]/advance/route");
const { guardAdvance } = await import("../guards");
const { createFakeLimiter } = await import("./fakeLimiter");

const GAME_A = "11111111-1111-4111-8111-111111111111";
const GAME_B = "22222222-2222-4222-8222-222222222222";
const req = (url: string, ip: string, body?: string) =>
  new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", body, headers: { "x-vercel-forwarded-for": ip } });
const create1 = (ip: string) => createGameRoute(req("/api/games", ip, "{}"));
const advance1 = (ip: string, id: string) =>
  advanceRoute(req(`/api/games/${id}/advance`, ip, '{"expectedVersion":1}'), { params: Promise.resolve({ id }) });
const get1 = (ip: string, id = GAME_A) => getGameRoute(req(`/api/games/${id}`, ip), { params: Promise.resolve({ id }) });

describe("límites por endpoint (con el adaptador de Upstash)", () => {
  beforeEach(() => {
    counts.clear();
    providerDown = false;
    create.mockClear();
    advanceGame.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("POST /api/games: 5 por IP; la 6.ª → 429 con Retry-After y sin datos internos; otra IP sigue pudiendo", async () => {
    for (let i = 0; i < 5; i++) expect((await create1("203.0.113.7")).status).toBe(201);
    const limited = await create1("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const text = await limited.text();
    expect(text).toContain("rate_limited");
    expect(text).not.toContain("203.0.113.7");
    expect(create).toHaveBeenCalledTimes(5); // la rechazada no llega a la BD
    expect((await create1("198.51.100.2")).status).toBe(201);
  });

  it("POST /api/games con el proveedor caído: 503 (fail-closed) sin crear nada", async () => {
    providerDown = true;
    const response = await create1("203.0.113.7");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("temporarily_unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("advance: cupo por IP + partida (una partida no agota la de otra) y la respuesta 409 no cambia", async () => {
    for (let i = 0; i < 180; i++) expect((await advance1("203.0.113.7", GAME_A)).status).toBe(409);
    const limited = await advance1("203.0.113.7", GAME_A);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await advance1("203.0.113.7", GAME_B)).status).toBe(409); // otra partida: su propio cupo
    expect((await advance1("198.51.100.2", GAME_A)).status).toBe(409); // otro espectador: no le afecta
    expect(advanceGame).toHaveBeenCalledTimes(182);
  });

  it("advance: además, 600/min por IP en total (un script contra muchas partidas)", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `${String(i + 3).repeat(8)}-0000-4000-8000-000000000000`);
    let ok = 0;
    for (let i = 0; i < 601; i++) if ((await advance1("203.0.113.9", ids[i % 6])).status !== 429) ok++;
    expect(ok).toBe(600);
  });

  it("advance con el proveedor caído: se deja pasar (fail-open) y llega al servicio", async () => {
    providerDown = true;
    expect((await advance1("203.0.113.7", GAME_A)).status).toBe(409);
    expect(advanceGame).toHaveBeenCalledTimes(1);
  });

  it("GET /api/games/[id]: límite suave de 120/min por IP; con el proveedor caído se deja pasar", async () => {
    for (let i = 0; i < 120; i++) expect((await get1("203.0.113.7")).status).toBe(404);
    expect((await get1("203.0.113.7")).status).toBe(429);
    expect((await get1("198.51.100.2")).status).toBe(404);
    providerDown = true;
    expect((await get1("203.0.113.7")).status).toBe(404);
  });

  it("sin límite superado, las respuestas y contratos no cambian (regresión)", async () => {
    const created = await create1("192.0.2.1");
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "0b6c3f6e-2f0a-4c3b-9d7e-1a2b3c4d5e6f", version: 1 });
    expect(create).toHaveBeenCalledWith(createGame([...CHARACTER_IDS]));
    const invalid = await advanceRoute(req(`/api/games/${GAME_A}/advance`, "192.0.2.1", "{}"), { params: Promise.resolve({ id: GAME_A }) });
    expect(invalid.status).toBe(400);
  });
});

describe("compatibilidad con espectadores reales (ventana deslizante exacta)", () => {
  /** `tabs` pestañas tras la misma IP, cada una ~1 petición cada 1,2 s (ritmo medido en Chrome), durante `seconds`. */
  async function simulate(tabs: number, seconds: number) {
    const { limiter, clock } = createFakeLimiter();
    let limited = 0;
    for (let ms = 0; ms < seconds * 1000; ms += 100) {
      clock.now = ms;
      for (let t = 0; t < tabs; t++) {
        if ((ms + t * 400) % 1200 !== 0) continue;
        const response = await guardAdvance(req(`/api/games/${GAME_A}/advance`, "203.0.113.50"), GAME_A, limiter);
        if (response) limited++;
      }
    }
    return limited;
  }

  it("1 y 3 pestañas tras la misma IP (NAT, varias pestañas) nunca reciben 429 en 5 minutos", async () => {
    expect(await simulate(1, 300)).toBe(0);
    expect(await simulate(3, 300)).toBe(0);
  });

  it("muchas pestañas tras la misma IP sí acaban limitadas (techo documentado: ~180/min por partida)", async () => {
    expect(await simulate(6, 120)).toBeGreaterThan(0);
  });
});
