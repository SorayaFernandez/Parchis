import { describe, expect, it } from "vitest";
import { CHARACTERS, CHAT_LINE_KINDS } from "@/lib/game/characters";
import { CHAT_LIMITS, CHAT_LLM } from "../../config";
import type { Utterance } from "../../director";
import type { ChatWriteRequest } from "../../writer";
import { buildChatPrompt } from "../prompt";

const utterance = (speaker: string, kind: Utterance["kind"], extra: Partial<Utterance> = {}): Utterance => ({
  speaker, kind, rival: "ai-blue", trigger: "capture", replyTo: null, important: true, ...extra,
});
const request = (u: Utterance, extra: Partial<ChatWriteRequest> = {}): ChatWriteRequest => ({ utterance: u, recent: [], replyToText: null, ...extra });

describe("buildChatPrompt", () => {
  it("un mensaje de sistema con el estilo de cada personaje y uno de usuario con la situación", () => {
    for (const c of CHARACTERS) {
      const [system, user] = buildChatPrompt(request(utterance(c.id, "capture_boast", { rival: c.id === "ai-blue" ? "ai-pink" : "ai-blue" })));
      expect(system.role).toBe("system");
      expect(system.content).toContain(`Eres ${c.name}`);
      expect(system.content).toContain(c.personality);
      expect(system.content).toContain(c.chat.register);
      expect(system.content).toContain(
        `UNA sola frase corta: como mucho ${CHAT_LLM.promptMaxWords} palabras y menos de ${CHAT_LLM.promptMaxChars} caracteres`,
      );
      expect(system.content).not.toContain("una o dos frases");
      expect(system.content).not.toContain(String(CHAT_LLM.maxChars)); // se pide menos que el límite de validación
      expect(system.content).toMatch(/No inventes/);
      expect(user.role).toBe("user");
      expect(user.content).toMatch(/^Situación: Acabas de capturar una ficha de (Chispa|Brava)/);
    }
  });

  it("pide menos que el límite de validación (140 sigue siendo el límite real)", () => {
    expect(CHAT_LLM.maxChars).toBe(140);
    expect(CHAT_LLM.promptMaxChars).toBe(120);
    expect(CHAT_LLM.promptMaxChars).toBeLessThan(CHAT_LLM.maxChars);
    expect(CHAT_LLM.promptMaxWords).toBeGreaterThan(0);
  });

  it("sin relleno y con recordatorio final de longitud y estilo", () => {
    for (const c of CHARACTERS) {
      const [system, user] = buildChatPrompt(request(utterance(c.id, "capture_lament", { rival: c.id === "ai-blue" ? "ai-pink" : "ai-blue" })));
      expect(system.content).toContain(
        "- Ve directo a tu reacción, como si lo dijeras en voz alta en la mesa: sin saludos, introducciones, explicaciones ni resumen de la jugada.",
      );
      // Las demás reglas y el estilo del personaje se mantienen.
      expect(system.content).toContain("sin comillas, sin tu nombre delante, sin emojis, sin listas");
      expect(system.content).toMatch(/No inventes números/);
      expect(system.content).toContain(`Forma de hablar: ${c.chat.register}`);
      expect(user.content.split("\n").at(-1)).toBe("Tu frase (una sola, corta y con tu estilo):");
    }
  });

  it("la situación de cada tipo usa solo los hechos dados (rival y racha reales)", () => {
    for (const kind of CHAT_LINE_KINDS) {
      const [, user] = buildChatPrompt(request(utterance("ai-green", kind, { streak: { count: 3, consecutive: false } })));
      expect(user.content).toMatch(/^Situación: \S/);
    }
    const [, streak] = buildChatPrompt(request(utterance("ai-pink", "streak_boast", { streak: { count: 3, consecutive: true } })));
    expect(streak.content).toContain("Llevas tres capturas seguidas.");
    const [, hunted] = buildChatPrompt(request(utterance("ai-pink", "streak_lament", { rival: "ai-purple", streak: { count: 2, consecutive: false } })));
    expect(hunted.content).toContain("Don Ernesto acaba de capturar una de tus fichas. Te han capturado dos veces en poco tiempo.");
    const [, win] = buildChatPrompt(request(utterance("ai-green", "victory_win", { rival: null })));
    expect(win.content).toContain("has ganado la partida");
  });

  it("incluye la réplica y solo los últimos textos recientes, recortados", () => {
    const long = "x".repeat(300);
    const recent = Array.from({ length: 10 }, (_, i) => ({ speaker: "ai-pink", text: `Texto reciente ${i}` }));
    const [, user] = buildChatPrompt(request(utterance("ai-blue", "capture_lament", { rival: "ai-pink" }), { recent: [...recent, { speaker: "ai-pink", text: long }], replyToText: long }));
    expect(user.content).toContain("Respondes a lo que acaba de decir Brava: «"); // el rival es quien dijo el mensaje
    expect(user.content).not.toContain("x".repeat(CHAT_LLM.recentTextMaxChars + 1));
    expect(user.content).toContain("Texto reciente 9");
    expect(user.content).not.toContain("Texto reciente 7"); // solo los últimos 3
  });

  it("no envía datos de la partida: el prompt es corto y no lleva identificadores internos", () => {
    const messages = buildChatPrompt(request(utterance("ai-purple", "victory_reply", { rival: "ai-green" }), { recent: [{ speaker: "ai-pink", text: "Hola" }] }));
    const all = messages.map((m) => m.content).join("\n");
    expect(all.length).toBeLessThan(CHAT_LLM.maxPromptChars); // ver el peor caso realista más abajo
    expect(all).not.toMatch(/ai-(pink|purple|green|blue)|version|steps|state|game_id|token/i);
  });

  it("personaje desconocido: lanza (el servicio usará el escritor local)", () => {
    expect(() => buildChatPrompt(request(utterance("ai-nadie", "goal")))).toThrow();
  });

  it("reglas de calidad: solo español, primera persona, nombres permitidos, sin coletillas copiadas, parchís y sin afirmaciones sin respaldo", () => {
    for (const c of CHARACTERS) {
      const rival = c.id === "ai-blue" ? "ai-pink" : "ai-blue";
      const [system] = buildChatPrompt(request(utterance(c.id, "capture_boast", { rival })));
      expect(system.content).toContain("Responde solo en español: ni palabras ni frases en otros idiomas.");
      expect(system.content).toContain("en primera persona");
      expect(system.content).toContain(`Solo puedes nombrar a ti (${c.name}) y ${CHARACTERS.find((x) => x.id === rival)!.name}; a nadie más, tampoco con parte del nombre ni con apodos.`);
      expect(system.content).toContain("No copies tus expresiones tal cual");
      expect(system.content).toContain("- Habla de parchís (fichas, dado, casa, meta, seguros, barreras)");
      expect(system.content).toContain("ni hables de rachas, salvo que la situación lo diga. Sí puedes picar y retar.");
      // La personalidad no cambia.
      expect(system.content).toContain(c.personality);
      expect(system.content).toContain(c.chat.register);
    }
    // Sin rival (victoria), solo su propio nombre.
    const [win] = buildChatPrompt(request(utterance("ai-green", "victory_win", { rival: null })));
    expect(win.content).toContain("Solo puedes nombrar a ti (Abuela Pilar); a nadie más");
  });

  it("metáforas deportivas solo para Chispa; otros juegos (reglas o situaciones) prohibidos para los cuatro", () => {
    for (const c of CHARACTERS) {
      const [system] = buildChatPrompt(request(utterance(c.id, "capture_boast", { rival: c.id === "ai-blue" ? "ai-pink" : "ai-blue" })));
      if (c.id === "ai-blue") {
        expect(system.content).toContain("Como comentarista puedes usar metáforas deportivas (¡gol!, ¡golazo!)");
        expect(system.content).toContain("pero nunca reglas o situaciones de otros juegos (tres en raya, jaque, fuera de juego, penalti…).");
        expect(system.content).not.toContain("no de otros juegos ni deportes");
      } else {
        expect(system.content, c.name).toContain("no de otros juegos ni deportes.");
        expect(system.content, c.name).not.toContain("metáforas deportivas");
      }
    }
  });

  it("solo Don Ernesto recibe la regla de tratar de usted", () => {
    for (const c of CHARACTERS) {
      const [system] = buildChatPrompt(request(utterance(c.id, "capture_lament", { rival: c.id === "ai-blue" ? "ai-pink" : "ai-blue" })));
      expect(system.content.includes("Trata siempre de usted"), c.name).toBe(c.id === "ai-purple");
    }
  });

  it("papeles explícitos: quién captura y quién pierde la ficha, también en las rachas y la victoria ajena", () => {
    const [, boast] = buildChatPrompt(request(utterance("ai-pink", "capture_boast", { rival: "ai-blue" })));
    expect(boast.content).toContain("Tú capturas y Chispa pierde la ficha: no te lamentes ni digas que la mala suerte es tuya.");
    const [, lament] = buildChatPrompt(request(utterance("ai-blue", "capture_lament", { rival: "ai-pink" })));
    expect(lament.content).toContain("Tú pierdes la ficha y Brava la captura: no presumas ni digas que la mala suerte es de Brava.");
    const [, hunted] = buildChatPrompt(request(utterance("ai-green", "streak_lament", { rival: "ai-blue", streak: { count: 2, consecutive: true } })));
    expect(hunted.content).toContain("Te han capturado dos veces seguidas. Tú pierdes la ficha y Chispa la captura");
    const [, reply] = buildChatPrompt(request(utterance("ai-purple", "victory_reply", { rival: "ai-pink" })));
    expect(reply.content).toContain("Brava acaba de ganar la partida, no tú.");
  });

  it("incluye sus propios textos recientes (los dos últimos) para que no repita coletillas", () => {
    const recent = [
      { speaker: "ai-pink", text: "¡A casa, Chispa!" },
      { speaker: "ai-blue", text: "¡Y el dado dice…!" },
      { speaker: "ai-pink", text: "¿Quién es el siguiente?" },
      { speaker: "ai-pink", text: "Eso no ha sido nada." },
    ];
    const [, user] = buildChatPrompt(request(utterance("ai-pink", "capture_boast", { rival: "ai-blue" }), { recent }));
    expect(user.content).toContain("Ya has dicho hace poco (no lo repitas): «¿Quién es el siguiente?» «Eso no ha sido nada.»");
    expect(user.content).not.toContain("Ya has dicho hace poco (no lo repitas): «¡A casa, Chispa!»");
    const [, other] = buildChatPrompt(request(utterance("ai-green", "capture_boast", { rival: "ai-blue" }), { recent }));
    expect(other.content).not.toContain("Ya has dicho hace poco");
  });

  it("tamaño máximo en el peor caso realista: réplica, historial completo, textos propios y todas las reglas", () => {
    const long = (n: number) => `Texto largo ${n} `.padEnd(CHAT_LIMITS.maxTextLength, "x");
    let max = 0;
    const kinds = ["capture_boast", "capture_lament", "streak_boast", "streak_lament", "victory_win", "victory_reply"] as const;
    for (const c of CHARACTERS) {
      const rival = c.id === "ai-blue" ? "ai-pink" : "ai-blue";
      for (const kind of kinds) {
        const recent = Array.from({ length: CHAT_LIMITS.recentTexts }, (_, i) => ({ speaker: i % 2 ? c.id : rival, text: long(i) }));
        const streak = kind.startsWith("streak") ? { streak: { count: 3, consecutive: false } } : {};
        const u = utterance(c.id, kind, { rival: kind === "victory_win" ? null : rival, replyTo: kind === "victory_win" ? null : 0, ...streak });
        const messages = buildChatPrompt(request(u, { recent, replyToText: long(99) }));
        const size = messages.reduce((n, m) => n + m.content.length, 0);
        max = Math.max(max, size);
        expect(size, `${c.name} ${kind}`).toBeLessThan(CHAT_LLM.maxPromptChars);
      }
    }
    // El peor caso medido ronda los 2600 caracteres (ver CHAT_LLM.maxPromptChars).
    expect(max).toBeGreaterThan(2000);
  });
});
