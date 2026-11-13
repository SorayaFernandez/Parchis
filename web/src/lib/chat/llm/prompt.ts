// Prompt del escritor LLM (puro). Solo lleva lo necesario para una intervención: el estilo del
// personaje (fijo) y los hechos que decidió el director (tipo, rival, racha, mensaje al que responde y
// unos pocos textos recientes). Nunca el estado de la partida.

import type { PlayerId } from "@/lib/engine";
import { CHARACTER_NAMES, getCharacter, type ChatLineKind } from "@/lib/game/characters";
import { CHAT_LLM } from "../config";
import type { StreakFacts, Utterance } from "../director";
import { countWord, type ChatWriteRequest } from "../writer";

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

const nameOf = (id: PlayerId | null) => (id ? (CHARACTER_NAMES[id] ?? id) : "");
const PILAR_ID = "ai-green";

/** Papeles explícitos de una captura: quién gana la ficha y quién la pierde (evita contradicciones). */
const youWin = (rival: string) => `Tú capturas y ${rival} pierde la ficha: no te lamentes ni digas que la mala suerte es tuya.`;
const youLose = (rival: string) => `Tú pierdes la ficha y ${rival} la captura: no presumas ni digas que la mala suerte es de ${rival}.`;

/** Lo que se dice con el historial incompleto: no hay datos fiables de recuentos ni de rachas. */
export const INCOMPLETE_HISTORY = "No sabes cuántas capturas lleva nadie ni si alguien está de racha: no des cifras ni hables de rachas.";

const ritmoOf = (facts: StreakFacts) => (facts.consecutive ? "seguidas" : "en poco tiempo");

/**
 * Hechos de rachas y capturas de una intervención de captura (`utterance.captures`), desde el punto de
 * vista de quien habla: su racha y la del rival (activa o recién interrumpida), sus malas rachas y las
 * capturas entre los dos en cada dirección (solo si son más de una). Sin hechos de racha no se dice
 * nada de rachas: la regla del sistema prohíbe inventarlas y el validador las rechaza.
 * La racha propia del mensaje principal (`streak_boast`/`streak_lament`) ya va en su situación.
 */
function captureContext(utterance: Utterance, rival: string): string {
  const c = utterance.captures;
  if (!c) return "";
  // Historial incompleto (versiones sin observar en la ventana): ni cifras ni rachas, solo esta captura.
  if (c.history === "incomplete") return ` ${INCOMPLETE_HISTORY}`;
  const n = countWord;
  const out: string[] = [];
  const { self, rival: other } = c;
  if (self.streak?.status === "active" && utterance.kind !== "streak_boast") out.push(`Llevas ${n(self.streak.count)} capturas ${ritmoOf(self.streak)}: tu racha sigue.`);
  if (self.badStreak?.status === "active" && utterance.kind !== "streak_lament") out.push(`Te han capturado ${n(self.badStreak.count)} veces ${ritmoOf(self.badStreak)}: tu mala racha sigue.`);
  if (other.streak?.status === "active") out.push(`${rival} lleva ${n(other.streak.count)} capturas ${ritmoOf(other.streak)}: su racha sigue.`);
  if (other.badStreak?.status === "active") out.push(`A ${rival} le han capturado ${n(other.badStreak.count)} veces ${ritmoOf(other.badStreak)}: su mala racha sigue.`);
  if (self.streak?.status === "ended") out.push(`Tu racha de ${n(self.streak.count)} capturas se acaba de cortar.`);
  if (self.badStreak?.status === "ended") out.push(`Tu mala racha se acaba de cortar (te habían capturado ${n(self.badStreak.count)} veces).`);
  if (other.streak?.status === "ended") out.push(`La racha de ${rival} (${n(other.streak.count)} capturas) se acaba de cortar.`);
  if (other.badStreak?.status === "ended") out.push(`La mala racha de ${rival} se acaba de cortar (le habían capturado ${n(other.badStreak.count)} veces).`);
  if (c.selfOnRival.count > 1) out.push(`Tú has capturado a ${rival} ${n(c.selfOnRival.count)} veces ${ritmoOf(c.selfOnRival)}.`);
  if (c.rivalOnSelf.count > 1) out.push(`${rival} te ha capturado ${n(c.rivalOnSelf.count)} veces ${ritmoOf(c.rivalOnSelf)}.`);
  // Varias capturas en poco tiempo NO son una racha activa si hubo una interrupción entre medias: el
  // disparador cuenta la ventana, pero la racha solo el tramo vivo (ver `captureFacts`).
  const capturerIsSelf = c.selfRole === "by";
  const capturer = capturerIsSelf ? self : other;
  const victim = capturerIsSelf ? other : self;
  if (utterance.trigger === "capture_streak" && !capturer.streak && capturer.made.count > capturer.madeSinceBreak.count) {
    const since = n(capturer.madeSinceBreak.count);
    if (!capturerIsSelf) {
      out.push(`${rival} lleva ${n(capturer.made.count)} capturas en poco tiempo, pero le capturaron entre medias: no está de racha, desde entonces lleva ${since}.`);
    } else if (utterance.kind === "streak_boast") {
      // El recuento de la ventana ya va en su situación («Llevas N capturas en poco tiempo.»).
      out.push(`Pero te capturaron entre medias: no estás de racha, desde entonces llevas ${since}.`);
    } else {
      out.push(`Llevas ${n(capturer.made.count)} capturas en poco tiempo, pero te capturaron entre medias: no estás de racha, desde entonces llevas ${since}.`);
    }
  }
  if (utterance.trigger === "bad_streak" && !victim.badStreak && victim.received.count > victim.receivedSinceBreak.count) {
    const since = `${n(victim.receivedSinceBreak.count)} ${victim.receivedSinceBreak.count === 1 ? "vez" : "veces"}`;
    if (capturerIsSelf) {
      out.push(`A ${rival} le han capturado ${n(victim.received.count)} veces en poco tiempo, pero capturó entre medias: no está de mala racha, desde entonces le han capturado ${since}.`);
    } else if (utterance.kind === "streak_lament") {
      // El recuento de la ventana ya va en su situación («Te han capturado N veces en poco tiempo.»).
      out.push(`Pero capturaste entre medias: no estás de mala racha, desde entonces te han capturado ${since}.`);
    } else {
      out.push(`Te han capturado ${n(victim.received.count)} veces en poco tiempo, pero capturaste entre medias: no estás de mala racha, desde entonces te han capturado ${since}.`);
    }
  }
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

/** Qué acaba de pasar, en segunda persona, para cada tipo de intervención. */
function situation(utterance: Utterance): string {
  const rival = nameOf(utterance.rival);
  // Con el historial incompleto no se usa ningún recuento, aunque llegara `streak`.
  const reliable = utterance.captures?.history !== "incomplete";
  const streak = reliable && utterance.streak
    ? ` Llevas ${countWord(utterance.streak.count)} capturas ${utterance.streak.consecutive ? "seguidas" : "en poco tiempo"}.`
    : "";
  const hunted = reliable && utterance.streak
    ? ` Te han capturado ${countWord(utterance.streak.count)} veces ${utterance.streak.consecutive ? "seguidas" : "en poco tiempo"}.`
    : "";
  const facts = captureContext(utterance, rival);
  const byKind: Record<ChatLineKind, string> = {
    victory_win: "Acabas de terminar el primero: has ganado la partida (los demás siguen jugando por los otros puestos).",
    victory_reply: `${rival} acaba de ganar la partida, no tú. La partida no ha terminado: los demás seguís jugando por los otros puestos. Reaccionas a su victoria.`,
    capture_boast: `Acabas de capturar una ficha de ${rival}: vuelve a su casa. ${youWin(rival)}${facts}`,
    capture_lament: `${rival} acaba de capturar una de tus fichas: vuelve a tu casa. ${youLose(rival)}${facts}`,
    streak_boast: `Acabas de capturar una ficha de ${rival}.${streak} ${youWin(rival)}${facts}`,
    streak_lament: `${rival} acaba de capturar una de tus fichas.${hunted} ${youLose(rival)}${facts}`,
    third_six_self: "Has sacado tres seises seguidos y te han castigado.",
    third_six_tease: `${rival} ha sacado tres seises seguidos y le han castigado.`,
    goal: "Una de tus fichas acaba de llegar a la meta.",
    finish_place: "Acabas de llevar todas tus fichas a la meta (no has quedado primero).",
    ambient_lead: `Vas el primero de la partida, en solitario${rival ? `; ${rival} va el último` : ""}.`,
    ambient_ahead: `La partida sigue abierta y no vas en cabeza${rival ? `; ${rival} va el último` : ""}.`,
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

  const names = utterance.rival ? `a ti (${character.name}) y a ${nameOf(utterance.rival)}` : `a ti (${character.name})`;
  // «Abuela» es la misma jugadora que Abuela Pilar: los demás pueden llamarla así (el validador lo
  // admite cuando participa). A la propia Pilar no se le dice: su vocativo «abuela» a otro se rechaza.
  const grandma = utterance.rival === PILAR_ID ? ` A ${nameOf(PILAR_ID)} también puedes llamarla «Abuela».` : "";
  // Concordancia de género (apelativos y adjetivos): el modelo la adivinaba y Pilar llamaba «hijita» a
  // Chispa y «hijito» a Brava. El validador rechaza los apelativos que no concuerdan con el destinatario.
  const genderWord = (gender: "f" | "m" | undefined) => (gender === "m" ? "masculino" : "femenino");
  const rivalCharacter = utterance.rival ? getCharacter(utterance.rival) : undefined;
  const gender = rivalCharacter
    ? `- Concuerda el género: habla de ti en ${genderWord(character.gender)} y de ${rivalCharacter.name} en ${genderWord(rivalCharacter.gender)}.`
    : `- Concuerda el género: habla de ti en ${genderWord(character.gender)}.`;
  // Prompt corto y sin contradicciones: el carácter en una línea (`chat.voice`) y pocas reglas en positivo.
  // Sin ejemplos de lo que no debe decir (nombrarlos se lo sugiere al modelo); de eso se encarga el validador.
  const system = [
    `Eres ${character.name}. Juegas una partida de parchís con otros tres y comentas en voz alta lo que acaba de pasar, como una persona más sentada a la mesa.`,
    `Tu carácter: ${character.chat.voice}`,
    "Reglas:",
    `- Una sola frase corta en español: como mucho ${CHAT_LLM.promptMaxWords} palabras y menos de ${CHAT_LLM.promptMaxChars} caracteres. Sin saludos, explicaciones ni resumen de la jugada.`,
    "- Habla como se habla en España jugando al parchís en casa: español coloquial y natural, con palabras sencillas de la partida (ficha, dado, comer, casa, meta, seis, turno). Sin metáforas, comparaciones ni frases solemnes; no hace falta ser gracioso.",
    "- Reacciona solo a lo que acaba de pasar. Tu carácter se nota en cómo lo dices, no en muletillas fijas.",
    `- Habla en primera persona y nombra solo ${names}, siempre con el nombre completo.${grandma} Sin comillas, emojis ni tu nombre delante.`,
    gender,
    ...(character.id === "ai-purple" ? ["- Trata siempre de usted a los demás (usted, su, le); nunca tutees."] : []),
    "- Cuenta solo lo que dice la situación: no inventes jugadas, cifras, posiciones ni rachas.",
    "- No repitas frases ni muletillas que ya hayas dicho. Puedes picar o bromear, pero sin insultos ni comentarios sobre que eres una IA.",
  ].join("\n");

  const lines = [`Situación: ${situation(utterance)}`];
  if (request.replyToText) {
    // En las réplicas, el rival es quien dijo el mensaje al que se responde (ver director.ts).
    const author = utterance.rival ? nameOf(utterance.rival) : null;
    lines.push(author ? `Respondes a lo que acaba de decir ${author}: «${clip(request.replyToText)}»` : `Respondes a este mensaje: «${clip(request.replyToText)}»`);
  }
  const own = request.recent.filter((r) => r.speaker === utterance.speaker).slice(-CHAT_LLM.ownRecentTexts);
  if (own.length > 0) lines.push(`Ya has dicho hace poco (no lo repitas): ${own.map((r) => `«${clip(r.text)}»`).join(" ")}`);
  // Los textos recientes de los demás (los propios ya van arriba), para no repetirlos.
  const recent = request.recent.slice(-CHAT_LLM.recentTexts).filter((r) => !own.includes(r));
  if (recent.length > 0) lines.push(`No repitas estas frases recientes: ${recent.map((r) => `«${clip(r.text)}»`).join(" ")}`);
  lines.push("Tu frase (una sola y corta):");

  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}
