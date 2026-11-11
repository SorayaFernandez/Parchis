import { describe, expect, it } from "vitest";
import { CHARACTERS, CHAT_LINE_KINDS } from "@/lib/game/characters";
import { CHAT_LLM } from "../../config";
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
      expect(system.content).toContain(`como máximo ${CHAT_LLM.maxChars} caracteres`);
      expect(system.content).toMatch(/No inventes/);
      expect(user.role).toBe("user");
      expect(user.content).toMatch(/^Situación: Acabas de capturar una ficha de (Chispa|Brava)/);
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
    expect(user.content).toContain("Respondes a este mensaje: «");
    expect(user.content).not.toContain("x".repeat(CHAT_LLM.recentTextMaxChars + 1));
    expect(user.content).toContain("Texto reciente 9");
    expect(user.content).not.toContain("Texto reciente 7"); // solo los últimos 3
  });

  it("no envía datos de la partida: el prompt es corto y no lleva identificadores internos", () => {
    const messages = buildChatPrompt(request(utterance("ai-purple", "victory_reply", { rival: "ai-green" }), { recent: [{ speaker: "ai-pink", text: "Hola" }] }));
    const all = messages.map((m) => m.content).join("\n");
    expect(all.length).toBeLessThan(1500);
    expect(all).not.toMatch(/ai-(pink|purple|green|blue)|version|steps|state|game_id|token/i);
  });

  it("personaje desconocido: lanza (el servicio usará el escritor local)", () => {
    expect(() => buildChatPrompt(request(utterance("ai-nadie", "goal")))).toThrow();
  });
});
