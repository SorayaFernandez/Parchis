import Image from "next/image";
import { COLOR_HEX, PIECE_IMAGES, PIECE_IMAGE_SCALE } from "@/lib/board/geometry";
import type { ChatMessage } from "@/lib/chat/schemas";
import type { Color, PlayerId } from "@/lib/engine";
import { cn } from "@/lib/utils";
import { ChatScroll } from "./ChatScroll";

interface ChatPanelProps {
  messages: readonly ChatMessage[];
  names: Readonly<Record<PlayerId, string>>;
  /** Color de cada personaje en esta partida. */
  colors: Readonly<Record<PlayerId, Color>>;
  className?: string;
  /** Clases extra del contenedor con scroll (p. ej., para que ocupe el alto disponible). */
  scrollClassName?: string;
}

const AVATAR = 28;

/**
 * Conversación entre los personajes (solo lectura: el espectador no escribe).
 * Sin hooks: el scroll (abajo por defecto y sin saltos al leer arriba, también en Safari) lo lleva
 * `ChatScroll`.
 */
export function ChatPanel({ messages, names, colors, className, scrollClassName }: ChatPanelProps) {
  const nameOf = (id: PlayerId) => names[id] ?? id;
  const bySeq = (m: ChatMessage, seq: number) => messages.find((o) => o.version === m.version && o.seq === seq);

  return (
    <section aria-label="Chat de los personajes" className={cn("rounded-2xl border border-white/10 bg-white/5 p-4", className)}>
      <h2 className="text-xs font-medium tracking-widest text-slate-400 uppercase">Chat</h2>
      {messages.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Los personajes todavía no han dicho nada.</p>
      ) : (
        <ChatScroll count={messages.length} className={cn("mt-2 max-h-72 pr-1 lg:max-h-80", scrollClassName)}>
          <ol role="log" aria-live="polite" aria-relevant="additions" className="space-y-2">
            {messages.map((m) => {
              const color = colors[m.characterId];
              const hex = color ? COLOR_HEX[color] : undefined;
              const repliedTo = m.replyToSeq === null ? undefined : bySeq(m, m.replyToSeq);
              return (
                <li key={m.id} data-chat-key={m.id} className={cn("flex gap-2", repliedTo && "pl-4")}>
                  {/* Avatar: la ficha del color, como en PlayersPanel. */}
                  <span
                    className="mt-0.5 grid shrink-0 place-items-center rounded-full border bg-slate-950"
                    style={{ width: AVATAR, height: AVATAR, borderColor: hex }}
                    aria-hidden
                  >
                    {color && (
                      <Image
                        src={PIECE_IMAGES[color]}
                        alt=""
                        width={48}
                        height={48}
                        className="size-5"
                        style={{ transform: `scale(${PIECE_IMAGE_SCALE})` }}
                      />
                    )}
                  </span>
                  <div
                    className="min-w-0 flex-1 rounded-xl border-l-2 bg-black/20 px-3 py-1.5"
                    style={{ borderLeftColor: hex }}
                  >
                    <p className="text-xs font-semibold" style={{ color: hex }}>
                      {nameOf(m.characterId)}
                      {repliedTo && (
                        <span className="font-normal text-slate-500"> · responde a {nameOf(repliedTo.characterId)}</span>
                      )}
                    </p>
                    <p className="text-sm break-words text-slate-100">{m.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </ChatScroll>
      )}
    </section>
  );
}
