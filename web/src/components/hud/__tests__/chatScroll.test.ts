// B6: conservar la posición de lectura del chat (WebKit/Safari no tiene anclaje de scroll de CSS).
// Vitest corre sin DOM: se usa un contenedor falso con las mismas propiedades que lee el código.
// Comprobado además en WebKitGTK y Chrome reales (ver CLAUDE.md, "Interfaz").

import { beforeAll, describe, expect, it } from "vitest";
import { captureChatAnchor, restoreChatAnchor } from "../chatScroll";

beforeAll(() => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
});

/** Contenedor de 300 px de alto con mensajes de 50 px; `scrollTop` 0 = abajo (column-reverse). */
function fakeChat(keys: string[], scrollTop: number) {
  const state = { scrollTop, keys: [...keys] };
  const itemTop = (i: number) => {
    // Abajo del todo (scrollTop 0) el último mensaje termina en 300; subir (negativo) baja el contenido.
    const contentBottom = 300 - state.scrollTop;
    return contentBottom - (state.keys.length - i) * 50;
  };
  const item = (i: number) => ({
    dataset: { chatKey: state.keys[i] },
    getBoundingClientRect: () => ({ top: itemTop(i), bottom: itemTop(i) + 50 }),
  });
  const container = {
    get scrollTop() { return state.scrollTop; },
    set scrollTop(v: number) { state.scrollTop = v; },
    getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
    querySelectorAll: () => state.keys.map((_, i) => item(i)),
    querySelector: (selector: string) => {
      const key = selector.match(/data-chat-key="(.+)"/)![1];
      const i = state.keys.indexOf(key);
      return i === -1 ? null : item(i);
    },
  };
  return { container: container as unknown as HTMLElement, state };
}

const keys = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe("chatScroll (B6)", () => {
  it("leyendo arriba, un mensaje nuevo desplaza el contenido (WebKit) y se compensa exactamente", () => {
    const { container, state } = fakeChat(keys(20), -200);
    const anchor = captureChatAnchor(container)!;
    expect(anchor).toMatchObject({ atBottom: false });
    const before = anchor.offset;
    state.keys.push("21"); // llega un mensaje: en WebKit el contenido sube 50 px
    const shift = restoreChatAnchor(container, anchor);
    expect(shift).toBe(-50);
    expect(state.scrollTop).toBe(-250);
    expect(captureChatAnchor(container)!).toMatchObject({ key: anchor.key, offset: before });
  });

  it("si el navegador ya lo compensó (anclaje de Chrome/Firefox), no corrige dos veces", () => {
    const { container, state } = fakeChat(keys(20), -200);
    const anchor = captureChatAnchor(container)!;
    state.keys.push("21");
    state.scrollTop = -250; // anclaje nativo
    expect(restoreChatAnchor(container, anchor)).toBe(0);
    expect(state.scrollTop).toBe(-250);
  });

  it("abajo (siguiendo los nuevos) no toca el scroll, tampoco con una posición anotada antigua", () => {
    const atBottom = fakeChat(keys(20), 0);
    const anchor = captureChatAnchor(atBottom.container)!;
    expect(anchor.atBottom).toBe(true);
    atBottom.state.keys.push("21");
    expect(restoreChatAnchor(atBottom.container, anchor)).toBe(0);

    // Anotado leyendo arriba, pero el espectador ya volvió abajo (el evento scroll aún no llegó).
    const stale = fakeChat(keys(20), -200);
    const old = captureChatAnchor(stale.container)!;
    stale.state.scrollTop = 0;
    stale.state.keys.push("21");
    expect(restoreChatAnchor(stale.container, old)).toBe(0);
    expect(stale.state.scrollTop).toBe(0);
  });

  it("sin posición anotada o sin el mensaje anotado: no hace nada", () => {
    const { container } = fakeChat(keys(5), -20);
    expect(restoreChatAnchor(container, null)).toBe(0);
    expect(restoreChatAnchor(container, { key: "999", offset: 0, atBottom: false })).toBe(0);
  });
});
