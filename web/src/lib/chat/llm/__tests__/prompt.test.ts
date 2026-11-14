import { describe, expect, it } from "vitest";
import { CHARACTERS, CHAT_LINE_KINDS } from "@/lib/game/characters";
import { CHAT_LIMITS, CHAT_LLM } from "../../config";
import { captureFacts, type Utterance } from "../../director";
import type { ChatWriteRequest } from "../../writer";
import { buildChatPrompt, INCOMPLETE_HISTORY } from "../prompt";

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
      expect(system.content).toContain(`Tu carácter: ${c.chat.voice}`);
      expect(system.content).toContain(
        `Una sola frase corta en español: como mucho ${CHAT_LLM.promptMaxWords} palabras y menos de ${CHAT_LLM.promptMaxChars} caracteres`,
      );
      expect(system.content).not.toContain("una o dos frases");
      expect(system.content).not.toContain(String(CHAT_LLM.maxChars)); // se pide menos que el límite de validación
      expect(system.content).toMatch(/no inventes jugadas, cifras, posiciones ni rachas/);
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
      expect(system.content).toContain("comentas en voz alta lo que acaba de pasar, como una persona más sentada a la mesa");
      expect(system.content).toContain("Sin saludos, explicaciones ni resumen de la jugada.");
      // Las demás reglas y el carácter del personaje se mantienen.
      expect(system.content).toContain("Sin comillas, emojis ni tu nombre delante.");
      expect(system.content).toMatch(/no inventes jugadas, cifras, posiciones ni rachas/);
      expect(system.content).toContain(`Tu carácter: ${c.chat.voice}`);
      expect(user.content.split("\n").at(-1)).toBe("Tu frase (una sola y corta):");
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
      expect(system.content).toContain("Una sola frase corta en español");
      expect(system.content).toContain("Habla en primera persona");
      expect(system.content).toContain(`nombra solo a ti (${c.name}) y a ${CHARACTERS.find((x) => x.id === rival)!.name}, siempre con el nombre completo.`);
      expect(system.content).toContain("No repitas frases ni muletillas que ya hayas dicho.");
      expect(system.content).toContain("Habla como se habla en España jugando al parchís en casa: español coloquial y natural, con palabras sencillas de la partida (ficha, dado, comer, casa, meta, seis, turno). Sin metáforas, comparaciones ni frases solemnes; no hace falta ser gracioso.");
      expect(system.content).toContain("Reacciona solo a lo que acaba de pasar. Tu carácter se nota en cómo lo dices, no en muletillas fijas.");
      expect(system.content).toContain("Cuenta solo lo que dice la situación: no inventes jugadas, cifras, posiciones ni rachas.");
      expect(system.content).toContain("Puedes picar o bromear, pero sin insultos");
      // El carácter de cada personaje va en una sola línea (`chat.voice`), sin descripciones duplicadas.
      expect(system.content).toContain(`Tu carácter: ${c.chat.voice}`);
      expect(system.content).not.toContain("Personalidad:");
      expect(system.content).not.toContain("Forma de hablar:");
    }
    // Sin rival (victoria), solo su propio nombre.
    const [win] = buildChatPrompt(request(utterance("ai-green", "victory_win", { rival: null })));
    expect(win.content).toContain("nombra solo a ti (Abuela Pilar), siempre con el nombre completo.");
  });

  it("sin contradicciones: nadie es comentarista ni recibe deportes, retransmisiones, otros juegos ni «cree en las rachas»", () => {
    // Ni permisos ni ejemplos de lo que el validador rechaza: nombrarlos se lo sugiere al modelo.
    const FORBIDDEN = /comentarista|metáforas deportivas|deport|fútbol|futbol|retransmi|golazo|¡gol|tres en raya|jaque|fuera de juego|penalti|bingo|cree en las rachas|teatral|juegos de palabras/i;
    for (const c of CHARACTERS) {
      for (const kind of ["capture_boast", "capture_lament", "streak_boast", "victory_win"] as const) {
        const u = utterance(c.id, kind, { rival: kind === "victory_win" ? null : c.id === "ai-blue" ? "ai-pink" : "ai-blue", streak: { count: 2, consecutive: true } });
        const [system, user] = buildChatPrompt(request(u));
        expect(FORBIDDEN.test(system.content), `${c.name}/${kind}: ${system.content.match(FORBIDDEN)?.[0]}`).toBe(false);
        expect(FORBIDDEN.test(user.content), `${c.name}/${kind}`).toBe(false);
      }
      expect(c.chat.voice, c.name).not.toMatch(/racha|comentarista/i);
    }
    // Chispa conserva su carácter: espontáneo, divertido y supersticioso con el dado.
    expect(CHARACTERS.find((c) => c.id === "ai-blue")!.chat.voice).toMatch(/espontáneo, divertido e imprevisible.*supersticioso con el dado/i);
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
    // La victoria es del primero en llegar: la partida sigue por los demás puestos (partida 010c5ace…).
    expect(reply.content).toContain("La partida no ha terminado: los demás seguís jugando por los otros puestos.");
    const [, win] = buildChatPrompt(request(utterance("ai-blue", "victory_win", { rival: null, trigger: "victory" })));
    expect(win.content).toContain("los demás siguen jugando por los otros puestos");
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
      // Abuela Pilar como rival siempre que se pueda: es el nombre más largo y añade la regla de «Abuela».
      const rival = c.id === "ai-green" ? "ai-pink" : "ai-green";
      for (const kind of kinds) {
        const recent = Array.from({ length: CHAT_LIMITS.recentTexts }, (_, i) => ({ speaker: i % 2 ? c.id : rival, text: long(i) }));
        const streak = kind.startsWith("streak") ? { streak: { count: 3, consecutive: false } } : {};
        // P4: todos los hechos de captura a la vez (más de los que pueden darse juntos), con cifras largas,
        // y la variante de reinicio (varias capturas en poco tiempo sin racha viva) en los dos disparadores.
        const f = (status: "active" | "ended") => ({ status, count: 12, consecutive: false });
        const n12 = { count: 12, consecutive: false };
        const n11 = { count: 11, consecutive: false };
        const all = { made: n12, received: n12, madeSinceBreak: n11, receivedSinceBreak: n11, streak: f("active"), badStreak: f("ended") };
        const variants: Partial<Utterance>[] = kind.startsWith("victory")
          ? [{}]
          : [
              { captures: { history: "complete", selfRole: "by", self: all, rival: { ...all, streak: f("ended"), badStreak: f("active") }, selfOnRival: n12, rivalOnSelf: n12 } },
              ...(["capture_streak", "bad_streak"] as const).map((trigger) => ({
                trigger,
                captures: { history: "complete" as const, selfRole: "by" as const, self: { ...all, streak: null, badStreak: f("ended") }, rival: { ...all, streak: f("ended"), badStreak: null }, selfOnRival: n12, rivalOnSelf: n12 },
              })),
            ];
        for (const extra of variants) {
          const u = utterance(c.id, kind, { rival: kind === "victory_win" ? null : rival, replyTo: kind === "victory_win" ? null : 0, ...streak, ...extra });
          const messages = buildChatPrompt(request(u, { recent, replyToText: long(99) }));
          const size = messages.reduce((n, m) => n + m.content.length, 0);
          max = Math.max(max, size);
          expect(size, `${c.name} ${kind}`).toBeLessThan(CHAT_LLM.maxPromptChars);
        }
      }
    }
    // El escenario es realista (no un caso corto) y, aun con todos los hechos de captura de P4, el prompt
    // simplificado mide menos que el anterior (2698 caracteres en el peor caso medido antes).
    expect(max).toBeGreaterThan(1500);
    expect(max).toBeLessThan(2698);
  });

  it("sin coletillas literales: el estilo se describe con `voice` y se mantienen personalidad y forma de hablar", () => {
    const plain = (t: string) => t.toLowerCase().replace(/[¡!¿?….,]/g, "").trim();
    const voices = new Set<string>();
    for (const c of CHARACTERS) {
      const [system, user] = buildChatPrompt(request(utterance(c.id, "capture_boast", { rival: c.id === "ai-blue" ? "ai-pink" : "ai-blue" })));
      for (const phrase of c.catchphrases) expect(plain(system.content + user.content), `${c.name}: ${phrase}`).not.toContain(plain(phrase));
      expect(system.content).not.toContain("Expresiones tuyas");
      expect(system.content).toContain(`Tu carácter: ${c.chat.voice}`);
      voices.add(c.chat.voice);
    }
    expect(voices.size).toBe(CHARACTERS.length);
    // Caracteres pedidos: Brava competitiva y directa; Ernesto sereno, formal y de usted; Pilar prudente y
    // cariñosa, con refranes o diminutivos sin repetirlos; Chispa espontáneo y supersticioso con el dado.
    const voiceOf = (id: string) => CHARACTERS.find((c) => c.id === id)!.chat.voice;
    expect(voiceOf("ai-pink")).toMatch(/competitiva, directa y desafiante.*pica a sus rivales.*presume.*protesta.*sin pasarse ni insultar/i);
    expect(voiceOf("ai-purple")).toMatch(/estratega sereno, calculador y educado.*usted.*precisión.*cálculo y probabilidad.*sin tecnicismos/i);
    expect(voiceOf("ai-green")).toMatch(/prudente, cariñosa y paciente, algo tradicional.*refrán o un diminutivo, sin repetirlos ni abusar/i);
    expect(voiceOf("ai-blue")).toMatch(/espontáneo, divertido e imprevisible, algo travieso y supersticioso con el dado/i);
  });

  it("situaciones de ambiente: liderar solo en `ambient_lead`; `ambient_ahead` no afirma ir en cabeza", () => {
    const [, lead] = buildChatPrompt(request(utterance("ai-pink", "ambient_lead", { rival: "ai-blue", trigger: "ambient", important: false })));
    expect(lead.content).toContain("Vas el primero de la partida, en solitario; Chispa va el último.");
    const [, ahead] = buildChatPrompt(request(utterance("ai-pink", "ambient_ahead", { rival: null, trigger: "ambient", important: false })));
    expect(ahead.content).toContain("La partida sigue abierta y no vas en cabeza.");
  });

  it("P4: hechos de racha y de pareja desde quien habla (mensajes y réplicas), sin heredar el recuento ajeno", () => {
    const c = (v: number, by: string, victim: string) => ({ v, by, victim });
    const facts = (log: ReturnType<typeof c>[], speaker: string) => {
      const last = log[log.length - 1];
      return captureFacts(log, last.v, last.by, last.victim, speaker);
    };
    // Racha de Brava (3 capturas, solo 1 contra Chispa): responde Chispa, la víctima.
    const hunt = [c(10, "ai-pink", "ai-green"), c(20, "ai-pink", "ai-purple"), c(30, "ai-pink", "ai-blue")];
    const huntReply = utterance("ai-blue", "capture_lament", { rival: "ai-pink", trigger: "capture_streak", replyTo: 0, captures: facts(hunt, "ai-blue") });
    const [, h] = buildChatPrompt(request(huntReply, { replyToText: "¡Otra más!" }));
    expect(h.content).toContain("Brava lleva tres capturas seguidas: su racha sigue.");
    expect(h.content).not.toMatch(/te ha capturado|se acaba de cortar/); // la pareja es 1: no se menciona
    // Mala racha de Chispa (Pilar y Brava): responde Brava, que solo la ha capturado una vez.
    const bad = [c(10, "ai-green", "ai-blue"), c(20, "ai-pink", "ai-blue")];
    const badReply = utterance("ai-pink", "capture_boast", { rival: "ai-blue", trigger: "bad_streak", replyTo: 0, captures: facts(bad, "ai-pink") });
    const [, b] = buildChatPrompt(request(badReply, { replyToText: "¡Otra vez yo!" }));
    expect(b.content).toContain("A Chispa le han capturado dos veces seguidas: su mala racha sigue.");
    expect(b.content).not.toMatch(/has capturado a Chispa/);
    // Pareja de verdad: Brava ha capturado dos veces seguidas a Chispa.
    const pair = [c(10, "ai-pink", "ai-blue"), c(20, "ai-pink", "ai-blue")];
    const [, p2] = buildChatPrompt(request(utterance("ai-blue", "capture_lament", { rival: "ai-pink", trigger: "capture_streak", replyTo: 0, captures: facts(pair, "ai-blue") })));
    expect(p2.content).toContain("Brava te ha capturado dos veces seguidas.");
    // Racha interrumpida: Brava llevaba 3 y Chispa la captura. Cada uno lo ve desde su lado.
    const cut = [...hunt.slice(0, 2), c(30, "ai-pink", "ai-green"), c(40, "ai-blue", "ai-pink")];
    const [, cutter] = buildChatPrompt(request(utterance("ai-blue", "capture_boast", { rival: "ai-pink", captures: facts(cut, "ai-blue") })));
    expect(cutter.content).toContain("La racha de Brava (tres capturas) se acaba de cortar.");
    expect(cutter.content).not.toContain("su racha sigue");
    const [, cutReply] = buildChatPrompt(request(utterance("ai-pink", "capture_lament", { rival: "ai-blue", replyTo: 0, captures: facts(cut, "ai-pink") })));
    expect(cutReply.content).toContain("Tu racha de tres capturas se acaba de cortar.");
    // Mala racha interrumpida: a Chispa la capturaron dos veces seguidas y ahora captura ella.
    const turn = [c(10, "ai-pink", "ai-blue"), c(20, "ai-green", "ai-blue"), c(30, "ai-blue", "ai-purple")];
    const [, t] = buildChatPrompt(request(utterance("ai-blue", "capture_boast", { rival: "ai-purple", captures: facts(turn, "ai-blue") })));
    expect(t.content).toContain("Tu mala racha se acaba de cortar (te habían capturado dos veces).");
    // Sin racha: no se habla de rachas ni de cifras.
    const [, plain] = buildChatPrompt(request(utterance("ai-purple", "capture_boast", { rival: "ai-blue", replyTo: 0, captures: facts([c(10, "ai-purple", "ai-blue")], "ai-purple") })));
    expect(plain.content).not.toMatch(/racha|veces|lleva|llevas/i);
    // R1: Brava v10, v20, v30; Chispa la corta en v40; Brava captura a Pilar en v50. Cuatro capturas en poco
    // tiempo, pero no está de racha: la secuencia nueva solo tiene una.
    const r1 = [c(10, "ai-pink", "ai-green"), c(20, "ai-pink", "ai-purple"), c(30, "ai-pink", "ai-green"), c(40, "ai-blue", "ai-pink"), c(50, "ai-pink", "ai-green")];
    const [, r1Reply] = buildChatPrompt(request(utterance("ai-green", "capture_lament", { rival: "ai-pink", trigger: "capture_streak", replyTo: 0, captures: facts(r1, "ai-green") })));
    expect(r1Reply.content).toContain("Brava lleva cuatro capturas en poco tiempo, pero le capturaron entre medias: no está de racha, desde entonces lleva una.");
    expect(r1Reply.content).not.toMatch(/Brava lleva cuatro capturas[^.]*: su racha sigue/);
    const [, r1Main] = buildChatPrompt(
      request(utterance("ai-pink", "streak_boast", { rival: "ai-green", trigger: "capture_streak", streak: { count: 4, consecutive: false }, captures: facts(r1, "ai-pink") })),
    );
    expect(r1Main.content).toContain("Llevas cuatro capturas en poco tiempo.");
    expect(r1Main.content).toContain("Pero te capturaron entre medias: no estás de racha, desde entonces llevas una.");
    expect(r1Main.content.match(/Llevas cuatro capturas/g)).toHaveLength(1);
    expect(r1Main.content).not.toContain("tu racha sigue");
    // R2: a Chispa la capturan en v10, v20, v30; captura ella en v40; la vuelven a capturar en v50.
    const r2 = [c(10, "ai-pink", "ai-blue"), c(20, "ai-green", "ai-blue"), c(30, "ai-purple", "ai-blue"), c(40, "ai-blue", "ai-purple"), c(50, "ai-pink", "ai-blue")];
    const [, r2Reply] = buildChatPrompt(request(utterance("ai-pink", "capture_boast", { rival: "ai-blue", trigger: "bad_streak", replyTo: 0, captures: facts(r2, "ai-pink") })));
    expect(r2Reply.content).toContain("A Chispa le han capturado cuatro veces en poco tiempo, pero capturó entre medias: no está de mala racha, desde entonces le han capturado una vez.");
    expect(r2Reply.content).not.toContain("su mala racha sigue");
    const [, r2Main] = buildChatPrompt(
      request(utterance("ai-blue", "streak_lament", { rival: "ai-pink", trigger: "bad_streak", streak: { count: 4, consecutive: false }, captures: facts(r2, "ai-blue") })),
    );
    expect(r2Main.content).toContain("Te han capturado cuatro veces en poco tiempo.");
    expect(r2Main.content).toContain("Pero capturaste entre medias: no estás de mala racha, desde entonces te han capturado una vez.");
    expect(r2Main.content).not.toContain("tu mala racha sigue");
    // Historial incompleto: ni cifras ni rachas (tampoco el `streak` del mensaje principal), solo esta captura.
    for (const [speaker, kind, selfRole] of [["ai-pink", "streak_boast", "by"], ["ai-blue", "capture_lament", "victim"], ["ai-blue", "streak_lament", "victim"]] as const) {
      const u = utterance(speaker, kind, { rival: speaker === "ai-pink" ? "ai-blue" : "ai-pink", trigger: "capture_streak", streak: { count: 3, consecutive: true }, captures: { history: "incomplete", selfRole } });
      const [, inc] = buildChatPrompt(request(u));
      expect(inc.content, kind).toContain(INCOMPLETE_HISTORY);
      expect(inc.content.replace(INCOMPLETE_HISTORY, ""), kind).not.toMatch(/racha|llevas|lleva |te han capturado [a-z]+ veces|seguidas|en poco tiempo|sigue\.|se acaba de cortar|\b(dos|tres|cuatro)\b/i);
    }
    // El mensaje principal de una racha mantiene su situación propia, sin repetirla.
    const [, main] = buildChatPrompt(request(utterance("ai-pink", "streak_boast", { rival: "ai-blue", trigger: "capture_streak", streak: { count: 3, consecutive: true }, captures: facts(hunt, "ai-pink") })));
    expect(main.content).toContain("Llevas tres capturas seguidas.");
    expect(main.content).not.toContain("tu racha sigue");
  });
});

describe("concordancia de género en el prompt", () => {
  const system = (speaker: string, rival: string | null) =>
    buildChatPrompt(request(utterance(speaker, rival ? "capture_boast" : "victory_win", { rival, trigger: rival ? "capture" : "victory" })))[0].content;

  it("indica el género de quien habla y el de su rival, en los dos sentidos", () => {
    expect(system("ai-green", "ai-blue")).toContain("- Concuerda el género: habla de ti en femenino y de Chispa en masculino.");
    expect(system("ai-green", "ai-pink")).toContain("- Concuerda el género: habla de ti en femenino y de Brava en femenino.");
    expect(system("ai-green", "ai-purple")).toContain("- Concuerda el género: habla de ti en femenino y de Don Ernesto en masculino.");
    expect(system("ai-blue", "ai-green")).toContain("- Concuerda el género: habla de ti en masculino y de Abuela Pilar en femenino.");
    expect(system("ai-purple", "ai-pink")).toContain("- Concuerda el género: habla de ti en masculino y de Brava en femenino.");
    expect(system("ai-pink", "ai-blue")).toContain("- Concuerda el género: habla de ti en femenino y de Chispa en masculino.");
  });

  it("sin rival (victoria propia), solo el género de quien habla", () => {
    for (const [speaker, word] of [["ai-pink", "femenino"], ["ai-purple", "masculino"], ["ai-green", "femenino"], ["ai-blue", "masculino"]] as const) {
      const content = system(speaker, null);
      expect(content).toContain(`- Concuerda el género: habla de ti en ${word}.`);
      expect(content).not.toMatch(/Concuerda el género: habla de ti en \w+ y de/);
    }
  });

  it("el prompt no sugiere apelativos concretos (de eso se encarga el validador)", () => {
    for (const c of CHARACTERS) expect(system(c.id, c.id === "ai-blue" ? "ai-pink" : "ai-blue")).not.toMatch(/hijit|hija|hijo|guap|maj[oa]/i);
  });
});

describe("frases citadas: contexto, no modelo de estilo", () => {
  const capture = utterance("ai-pink", "capture_boast", { rival: "ai-blue", replyTo: 0 });

  it("las reglas mandan sobre lo citado (en el mensaje de sistema, antes de cualquier cita)", () => {
    const [system, user] = buildChatPrompt(request(capture, { replyToText: "¡Te comí, Brava!" }));
    expect(system.content).toContain("Lo citado no es un modelo: mandan estas reglas.");
    expect(user.content).not.toContain("mandan estas reglas");
  });

  it("no se citan frases recientes con expresiones descartadas; las válidas y el mensaje al que se responde, sí", () => {
    const recent = [
      { speaker: "ai-pink", text: "¡En cabeza y sin frenar! ¿Quién me sigue?" },
      { speaker: "ai-pink", text: "¡Te comí, Chispa!" },
      { speaker: "ai-blue", text: "Otro golpe, Chispa. No te rindas aún." },
      { speaker: "ai-green", text: "La presión constante da sus frutos, Brava." },
      { speaker: "ai-blue", text: "¡Dadme ese seis, por favor!" },
      { speaker: "ai-purple", text: "Qué bien lo haces, Chispa. ¡Vamos por la quinta!" },
      { speaker: "ai-blue", text: "Me comiste, Brava. Ya te pillaré." },
    ];
    const [, user] = buildChatPrompt(request(capture, { recent, replyToText: "Me comiste, Brava. Ya te pillaré." }));
    for (const bad of ["sin frenar", "golpe", "da sus frutos", "Dadme ese seis", "por la quinta"]) expect(user.content, bad).not.toContain(bad);
    expect(user.content).toContain("Ya has dicho hace poco (no lo repitas): «¡Te comí, Chispa!»");
    expect(user.content).toContain("«Me comiste, Brava. Ya te pillaré.»");
    expect(user.content).toContain("Respondes a lo que acaba de decir Chispa: «Me comiste, Brava. Ya te pillaré.»");
  });

  it("sin expresiones descartadas, se citan como antes (los 2 propios y los 3 últimos de los demás)", () => {
    const recent = [
      { speaker: "ai-blue", text: "Uno" },
      { speaker: "ai-pink", text: "Dos" },
      { speaker: "ai-green", text: "Tres" },
      { speaker: "ai-pink", text: "Cuatro" },
      { speaker: "ai-purple", text: "Cinco" },
    ];
    const [, user] = buildChatPrompt(request(capture, { recent }));
    expect(user.content).toContain("Ya has dicho hace poco (no lo repitas): «Dos» «Cuatro»");
    expect(user.content).toContain("No repitas estas frases recientes: «Tres» «Cinco»");
  });
});
