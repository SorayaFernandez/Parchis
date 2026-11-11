import { describe, expect, it, vi } from "vitest";
import { NewGameController, interpretCreateResponse } from "../newGame";

const ID = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

/** fetch falso que responde cuando la prueba lo decide (para ver el estado intermedio). */
function deferredFetch() {
  const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void; init?: RequestInit; url: string }[] = [];
  const fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => pending.push({ resolve, reject, init, url: String(input) })),
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, spy: fetch, pending };
}

const created = () => Response.json({ id: ID, version: 1 }, { status: 201 });

describe("interpretCreateResponse", () => {
  it("201 con un id válido → partida creada", () => {
    expect(interpretCreateResponse(201, { id: ID, version: 1 })).toEqual({ kind: "created", id: ID });
  });

  it("errores con mensajes comprensibles y sin detalles técnicos", () => {
    expect(interpretCreateResponse(429, {}, "45")).toEqual({ kind: "error", message: "Se han creado muchas partidas seguidas. Espera 45 s y vuelve a intentarlo." });
    expect(interpretCreateResponse(429, {}, "240")).toMatchObject({ kind: "error", message: expect.stringContaining("Espera 4 min") });
    expect(interpretCreateResponse(429, {}, null)).toMatchObject({ kind: "error", message: expect.stringContaining("Espera unos minutos") });
    expect(interpretCreateResponse(503, { error: { code: "storage_unavailable" } })).toEqual({
      kind: "error",
      message: "El servicio de partidas no está disponible ahora mismo. Inténtalo en unos segundos.",
    });
    expect(interpretCreateResponse(500, { error: { code: "server_misconfigured" } })).toEqual({
      kind: "error",
      message: "No se ha podido crear la partida. Inténtalo de nuevo.",
    });
    expect(interpretCreateResponse(400, null).kind).toBe("error");
  });

  it("201 con una respuesta inesperada (sin id o id que no es UUID) → error, nunca navega a una ruta rota", () => {
    expect(interpretCreateResponse(201, null).kind).toBe("error");
    expect(interpretCreateResponse(201, { id: "../admin", version: 1 }).kind).toBe("error");
    expect(interpretCreateResponse(201, { version: 1 }).kind).toBe("error");
  });
});

describe("NewGameController (botón «Nueva partida»)", () => {
  it("al pulsar: estado de carga, POST /api/games y, al crearse, navega a /partida/[id]", async () => {
    const f = deferredFetch();
    const navigate = vi.fn();
    const controller = new NewGameController({ fetch: f.fetch, navigate });
    const states: string[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot().kind));

    const done = controller.create();
    expect(controller.getSnapshot()).toEqual({ kind: "creating" });
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0].url).toBe("/api/games");
    expect(f.pending[0].init).toMatchObject({ method: "POST", body: "{}", cache: "no-store" });

    f.pending[0].resolve(created());
    await done;
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/partida/${ID}`);
    // Mientras se navega sigue en carga (el botón sigue desactivado).
    expect(controller.getSnapshot()).toEqual({ kind: "creating" });
    expect(states).toEqual(["creating"]);
  });

  it("evita solicitudes duplicadas: varios clics mientras se crea (o mientras se navega) hacen una sola petición", async () => {
    const f = deferredFetch();
    const navigate = vi.fn();
    const controller = new NewGameController({ fetch: f.fetch, navigate });
    const first = controller.create();
    await controller.create();
    await controller.create();
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.pending[0].resolve(created());
    await first;
    await controller.create(); // ya navegando
    expect(f.spy).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("si falla, muestra el error y permite reintentar; al reintentar con éxito, navega", async () => {
    const f = deferredFetch();
    const navigate = vi.fn();
    const controller = new NewGameController({ fetch: f.fetch, navigate });

    const attempt = controller.create();
    f.pending[0].resolve(Response.json({ error: { code: "storage_unavailable" } }, { status: 503 }));
    await attempt;
    expect(controller.getSnapshot()).toEqual({
      kind: "error",
      message: "El servicio de partidas no está disponible ahora mismo. Inténtalo en unos segundos.",
    });
    expect(navigate).not.toHaveBeenCalled();

    const retry = controller.create();
    expect(controller.getSnapshot()).toEqual({ kind: "creating" });
    f.pending[1].resolve(created());
    await retry;
    expect(f.spy).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/partida/${ID}`);
  });

  it("sin red o con límite de creación: mensajes propios, sin navegar", async () => {
    const offline = new NewGameController({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, navigate: vi.fn() });
    await offline.create();
    expect(offline.getSnapshot()).toEqual({ kind: "error", message: "No hay conexión con el servidor. Comprueba la red e inténtalo de nuevo." });

    const navigate = vi.fn();
    const limited = new NewGameController({
      fetch: (async () => Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "120" } })) as unknown as typeof fetch,
      navigate,
    });
    await limited.create();
    expect(limited.getSnapshot()).toEqual({ kind: "error", message: "Se han creado muchas partidas seguidas. Espera 2 min y vuelve a intentarlo." });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("respuesta no JSON del servidor: error, no se queda bloqueado en carga", async () => {
    const controller = new NewGameController({
      fetch: (async () => new Response("<html>Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch,
      navigate: vi.fn(),
    });
    await controller.create();
    expect(controller.getSnapshot().kind).toBe("error");
  });
});
