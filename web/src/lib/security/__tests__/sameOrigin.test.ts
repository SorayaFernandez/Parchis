import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { checkSameOriginJsonPost } = await import("../sameOrigin");

const APP = "https://parchis.example.com";
const JSON_TYPE = { "Content-Type": "application/json" };
const req = (headers: Record<string, string>, url = `${APP}/api/games`) =>
  new Request(url, { method: "POST", body: "{}", headers });
/** Código de error de la respuesta, o `null` si la petición se acepta. */
async function verdict(request: Request): Promise<{ status: number; code: string } | null> {
  const response = checkSameOriginJsonPost(request);
  if (!response) return null;
  return { status: response.status, code: (await response.json()).error.code };
}
const FORBIDDEN = { status: 403, code: "forbidden_origin" };
const UNSUPPORTED = { status: 415, code: "unsupported_media_type" };

describe("checkSameOriginJsonPost", () => {
  it("acepta las peticiones legítimas de la propia aplicación (como las de newGame.ts y liveController.ts)", async () => {
    const cases: Record<string, string>[] = [
      { ...JSON_TYPE, Origin: APP, "Sec-Fetch-Site": "same-origin" },
      { ...JSON_TYPE, Origin: APP },
      { ...JSON_TYPE, Origin: "HTTPS://PARCHIS.EXAMPLE.COM" },
      { "Content-Type": "application/json; charset=utf-8", Origin: APP },
      { "Content-Type": "Application/JSON", Origin: APP },
      { ...JSON_TYPE, Origin: APP, "Sec-Fetch-Site": "same-site" },
      { ...JSON_TYPE, Origin: APP, "Sec-Fetch-Site": "none" },
    ];
    for (const headers of cases) expect(await verdict(req(headers)), JSON.stringify(headers)).toBeNull();
  });

  it("acepta clientes sin Origin ni Sec-Fetch-Site (no son navegadores), con cuerpo JSON", async () => {
    expect(await verdict(req(JSON_TYPE))).toBeNull();
  });

  it("detrás de un proxy: el origen se compara con Host o X-Forwarded-Host, no solo con la URL interna", async () => {
    const internal = "http://localhost:3000/api/games";
    expect(await verdict(req({ ...JSON_TYPE, Origin: APP, Host: "parchis.example.com" }, internal))).toBeNull();
    expect(await verdict(req({ ...JSON_TYPE, Origin: APP, "X-Forwarded-Host": "parchis.example.com" }, internal))).toBeNull();
    expect(await verdict(req({ ...JSON_TYPE, Origin: "http://localhost:3000" }, internal))).toBeNull();
    // Mismo host con otro puerto: es otro origen.
    expect(await verdict(req({ ...JSON_TYPE, Origin: "http://localhost:4000" }, internal))).toEqual(FORBIDDEN);
  });

  it("rechaza con 403 un Origin externo, aunque el resto sea correcto", async () => {
    for (const origin of [
      "https://evil.example",
      "https://parchis.example.com.evil.example",
      "https://evil.parchis.example.com",
      "http://parchis.example.com:8080",
      "null",
      "no-es-un-origen",
      "ftp://parchis.example.com",
      "",
    ]) {
      expect(await verdict(req({ ...JSON_TYPE, Origin: origin })), origin).toEqual(FORBIDDEN);
    }
  });

  it("rechaza con 403 Sec-Fetch-Site: cross-site, con o sin Origin", async () => {
    expect(await verdict(req({ ...JSON_TYPE, "Sec-Fetch-Site": "cross-site" }))).toEqual(FORBIDDEN);
    expect(await verdict(req({ ...JSON_TYPE, "Sec-Fetch-Site": "Cross-Site", Origin: APP }))).toEqual(FORBIDDEN);
    expect(await verdict(req({ ...JSON_TYPE, "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" }))).toEqual(FORBIDDEN);
  });

  it("same-site no basta: el Origin debe ser exactamente el de la aplicación", async () => {
    expect(await verdict(req({ ...JSON_TYPE, "Sec-Fetch-Site": "same-site", Origin: "https://otra.example.com" }))).toEqual(FORBIDDEN);
  });

  it("exige Content-Type: application/json (415) para cualquier otro tipo o sin él", async () => {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "application/json-patch+json", ""]) {
      expect(await verdict(req({ "Content-Type": type, Origin: APP })), type).toEqual(UNSUPPORTED);
    }
    // Sin la cabecera (un cuerpo de texto la pondría como text/plain: se quita a mano).
    const bare = new Request(`${APP}/api/games`, { method: "POST" });
    expect(bare.headers.get("content-type")).toBeNull();
    expect(await verdict(bare)).toEqual(UNSUPPORTED);
  });

  it("el origen se comprueba antes que el tipo: un formulario de otro sitio recibe 403", async () => {
    expect(await verdict(req({ "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }))).toEqual(FORBIDDEN);
  });

  it("respuestas genéricas, sin caché y sin datos de la petición", async () => {
    const response = checkSameOriginJsonPost(req({ ...JSON_TYPE, Origin: "https://evil.example" }))!;
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ error: { code: "forbidden_origin", message: "Petición no permitida." } });
    expect(JSON.stringify(body)).not.toContain("evil");
    const unsupported = checkSameOriginJsonPost(req({ "Content-Type": "text/plain" }))!;
    expect(unsupported.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys((await unsupported.json()).error)).toEqual(["code", "message"]);
  });
});
