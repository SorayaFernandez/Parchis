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
  it("muestra «Nueva partida» y mantiene el acceso al tablero de demostración", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toMatch(/<button[^>]*>Nueva partida<\/button>/);
    expect(html).toContain('href="/tablero"');
    expect(html).toContain("Ver el tablero (demo)");
    // Sin registro, login ni participación humana.
    expect(html).not.toMatch(/iniciar sesión|registr|login|<input/i);
  });

  it("NewGameButton se puede renderizar en el servidor (estado inicial)", () => {
    expect(renderToStaticMarkup(<NewGameButton />)).toContain("Nueva partida");
  });
});
