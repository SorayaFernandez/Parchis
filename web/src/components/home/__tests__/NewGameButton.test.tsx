import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// El botón usa el router de la app; fuera de Next se simula.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const { NewGameButton, NewGameButtonView } = await import("../NewGameButton");
const { default: Home } = await import("@/app/page");

const noop = () => {};

describe("NewGameButtonView", () => {
  it("en reposo: botón «Nueva partida» activo y sin error", () => {
    const html = renderToStaticMarkup(<NewGameButtonView state={{ kind: "idle" }} onCreate={noop} />);
    expect(html).toMatch(/<button[^>]*>Nueva partida<\/button>/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain('role="alert"');
  });

  it("creando: botón desactivado (sin dobles clics), texto de carga y estado anunciado", () => {
    const html = renderToStaticMarkup(<NewGameButtonView state={{ kind: "creating" }} onCreate={noop} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Creando partida…<\/button>/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Preparando el tablero y los cuatro personajes…");
  });

  it("con error: mensaje comprensible en una alerta y botón «Reintentar» activo", () => {
    const html = renderToStaticMarkup(
      <NewGameButtonView state={{ kind: "error", message: "No hay conexión con el servidor." }} onCreate={noop} />,
    );
    expect(html).toMatch(/<p role="alert"[^>]*>No hay conexión con el servidor\.<\/p>/);
    expect(html).toMatch(/<button[^>]*>Reintentar<\/button>/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe("portada", () => {
  it("muestra «Nueva partida» y mantiene el acceso al tablero de demostración", async () => {
    const html = renderToStaticMarkup(await Home());
    expect(html).toMatch(/<button[^>]*>Nueva partida<\/button>/);
    expect(html).toContain('href="/tablero"');
    expect(html).toContain("Ver una partida de demostración");
    // Sin registro, login ni participación humana (el «Sin registro» informa de que no hace falta).
    expect(html).not.toMatch(/iniciar sesión|registrarse|login|<input/i);
  });

  it("presenta un juego terminado: sin «En construcción», con los cuatro personajes y solo enlaces que funcionan", async () => {
    const html = renderToStaticMarkup(await Home());
    expect(html).not.toMatch(/en construcción|próximamente|beta/i);
    for (const name of ["Brava", "Don Ernesto", "Abuela Pilar", "Chispa"]) expect(html).toContain(name);
    for (const tagline of ["Agresiva y competitiva", "Estratega y calculador", "Prudente y entrañable", "Imprevisible y divertido"]) expect(html).toContain(tagline);
    expect(html).toContain("Ellos juegan. Tú miras.");
    // Las dos llamadas a la acción, arriba y al final: la partida real (botón) y la demostración (/tablero).
    expect(html.match(/<button[^>]*>Nueva partida<\/button>/g)).toHaveLength(2);
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set(["/tablero"]));
    // El tablero real con fichas de una partida a mitad de juego.
    expect(html).toContain('aria-label="Tablero de Parchís"');
    expect(html.match(/<title>Ficha /g)).toHaveLength(16);
  });

  it("NewGameButton se puede renderizar en el servidor (estado inicial)", () => {
    expect(renderToStaticMarkup(<NewGameButton />)).toContain("Nueva partida");
  });
});

describe("portada: comentario de ejemplo de Abuela Pilar", () => {
  it("muestra «Ay, Chispa, me has comido la ficha.» y no la frase antigua", async () => {
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("Ay, Chispa, me has comido la ficha.");
    expect(html).not.toContain("No hay mal que por bien no venga");
  });
});

describe("portada: textos", () => {
  it("quedan exactamente como se pidió", async () => {
    const html = renderToStaticMarkup(await Home());
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // «Parchís» en la marca, el título y el pie; ya no «Parchís IA» ni el enlace «Demostración» de la cabecera.
    expect(text).not.toContain("Parchís IA");
    expect(html.match(/>Parchís</g)?.length).toBeGreaterThanOrEqual(3);
    expect(text).not.toMatch(/\bDemostración\b/);
    expect(text).toContain("hablan por el chat");
    expect(text).not.toContain("se pican en el chat");
    expect(text).toContain("Tiran, deciden cada jugada y se comen fichas, siguiendo las reglas del parchís.");
    expect(text).not.toContain("con las reglas del parchís");
    expect(text).not.toContain("No son simples avatares");
    // La demostración sigue accesible desde las llamadas a la acción.
    expect(text).toContain("Ver una partida de demostración");
  });
});
