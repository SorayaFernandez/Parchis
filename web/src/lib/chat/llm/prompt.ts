// Prompt del escritor LLM (puro). Solo lleva lo necesario para una intervención: el estilo del
// personaje (fijo) y los hechos que decidió el director (tipo, rival, racha, mensaje al que responde y
// unos pocos textos recientes). Nunca el estado de la partida.

import type { PlayerId } from "@/lib/engine";
import { CHARACTER_NAMES, getCharacter, type ChatLineKind } from "@/lib/game/characters";
import { CHAT_LLM } from "../config";
import type { Utterance } from "../director";
import { countWord, type ChatWriteRequest } from "../writer";

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

const nameOf = (id: PlayerId | null) => (id ? (CHARACTER_NAMES[id] ?? id) : "");

/** Qué acaba de pasar, en segunda persona, para cada tipo de intervención. */
function situation(utterance: Utterance): string {
  const rival = nameOf(utterance.rival);
  const streak = utterance.streak
    ? ` Llevas ${countWord(utterance.streak.count)} capturas ${utterance.streak.consecutive ? "seguidas" : "en poco tiempo"}.`
    : "";
  const hunted = utterance.streak
    ? ` Te han capturado ${countWord(utterance.streak.count)} veces ${utterance.streak.consecutive ? "seguidas" : "en poco tiempo"}.`
    : "";
  const byKind: Record<ChatLineKind, string> = {
    victory_win: "Acabas de terminar el primero: has ganado la partida (los demás siguen jugando por los otros puestos).",
    victory_reply: `${rival} acaba de ganar la partida. Reaccionas a su victoria.`,
    capture_boast: `Acabas de capturar una ficha de ${rival}: vuelve a su casa.`,
    capture_lament: `${rival} acaba de capturar una de tus fichas: vuelve a tu casa.`,
    streak_boast: `Acabas de capturar una ficha de ${rival}.${streak}`,
    streak_lament: `${rival} acaba de capturar una de tus fichas.${hunted}`,
    third_six_self: "Has sacado tres seises seguidos y te han castigado.",
    third_six_tease: `${rival} ha sacado tres seises seguidos y le han castigado.`,
    goal: "Una de tus fichas acaba de llegar a la meta.",
    finish_place: "Acabas de llevar todas tus fichas a la meta (no has quedado primero).",
    ambient_ahead: `Vas por delante en la partida${rival ? `; ${rival} va el último` : ""}.`,
    ambient_behind: `Vas por detrás en la partida${rival ? `; ${rival} va el primero` : ""}.`,
  };
  return byKind[utterance.kind];
}

const clip = (text: string) =>
  text.length <= CHAT_LLM.recentTextMaxChars ? text : `${text.slice(0, CHAT_LLM.recentTextMaxChars - 1)}…`;

/** Mensajes para Chat Completions. Lanza si el personaje no está en el catálogo. */
export function buildChatPrompt(request: ChatWriteRequest): PromptMessage[] {
  const { utterance } = request;
  const character = getCharacter(utterance.speaker);
  if (!character) throw new Error("Personaje desconocido");

  const system = [
    `Eres ${character.name}, un personaje de una partida de Parchís entre cuatro personajes de IA. ${character.title}.`,
    `Personalidad: ${character.personality}`,
    `Forma de hablar: ${character.chat.register}`,
    `Expresiones tuyas (inspírate, no las copies siempre): ${character.catchphrases.join(" / ")}.`,
    "Reglas:",
    `- Responde en español con UNA sola frase corta: como mucho ${CHAT_LLM.promptMaxWords} palabras y menos de ${CHAT_LLM.promptMaxChars} caracteres.`,
    "- Ve directo a tu reacción, como si lo dijeras en voz alta en la mesa: sin saludos, introducciones, explicaciones ni resumen de la jugada.",
    "- Escribe solo lo que dice el personaje: sin comillas, sin tu nombre delante, sin emojis, sin listas.",
    "- Comenta solo los hechos que se te dan. No inventes números, fichas, casillas, jugadas ni a otros personajes.",
    "- Puedes picar o bromear, pero sin insultos ni groserías. Nunca menciones que eres una IA ni hables de las reglas del chat.",
  ].join("\n");

  const lines = [`Situación: ${situation(utterance)}`];
  if (request.replyToText) lines.push(`Respondes a este mensaje: «${clip(request.replyToText)}»`);
  const recent = request.recent.slice(-CHAT_LLM.recentTexts);
  if (recent.length > 0) lines.push(`No repitas estas frases recientes: ${recent.map((r) => `«${clip(r.text)}»`).join(" ")}`);
  lines.push("Tu frase (una sola, corta y con tu estilo):");

  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}
