import { useEffect, useState } from "react";
import { socket } from "../../socket/socket";
import { useTranslation } from "react-i18next";

type ChatMessage = {
  userId: number;
  color: string;
  message: string;
  timestamp: number;
};

export default function ChatPanel({
  game,
}: any) {
  const [msg, setMsg] = useState("");
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const onMessage = (
      data: ChatMessage
    ) => {
      setMessages((prev) => [
        ...prev,
        data,
      ]);
    };

    socket.on(
      "chat:message",
      onMessage
    );

    return () => {
      socket.off(
        "chat:message",
        onMessage
      );
    };
  }, []);

  const send = () => {
    const clean = msg.trim();

    if (!clean || clean.length > 30)
      return;

    socket.emit("chat:send", {
      gameId: game.id,
      message: msg,
    });

    setMsg("");
  };

  return (
    <div className="glass-panel rounded-3xl p-4 flex-1 flex flex-col gap-3 min-h-0">
      <div className="font-semibold text-white/80">
        {t("chatPanel.title")}
      </div>

      <div
        className="
          flex-1
          overflow-y-auto
          rounded-2xl
          bg-black/20
          border
          border-white/5
          p-3
          space-y-2
        "
      >
        {messages.map((m, index) => {
          const username = game.players.find((p: any) => p.id === m.userId)?.username ?? m.color;

          return (
            <div
              key={index}
              className="
                text-sm
                break-words
              "
            >
              <span
                className="
                  font-semibold
                  text-cyan-400
                "
              >
                {username}
              </span>

              <span className="mx-2">
                :
              </span>

              <span>
                {m.message}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 items-center">
        <input
          value={msg}
          maxLength={30}
          onChange={(e) =>
            setMsg(
              e.target.value
            )
          }
          onKeyDown={(e) => {
            if (
              e.key === "Enter"
            ) {
              send();
            }
          }}
          className="
            flex-1
            min-w-0
            rounded-xl
            bg-black/30
            border
            border-white/10
            p-3
            outline-none
          "
          placeholder={t("chatPanel.placeholder")}
        />

        <button
          onClick={send}
          className="
            shrink-0
            px-4
            py-3
            rounded-xl
            bg-purple-500
            border
            border-white/30
          "
        >
          {t("chatPanel.send")}
        </button>
      </div>
    </div>
  );
}