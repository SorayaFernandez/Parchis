import { socket } from "../../socket/socket";
import { useAuth } from "../../context/AuthContext";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { validateText } from "../../utils/validation";
import { useTranslation } from "react-i18next";

type LobbyMessage = {
	id: number;
	message: string;
	created_at: string;
	expected_reads?: number;
	read_by?: number[];
	user?: {
		id: number;
		username: string;
		avatar_url?: string;
	};
	system?: boolean;
};

export default function LobbyChat() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [messages, setMessages] = useState<LobbyMessage[]>([]);
  const [message, setMessage] = useState("");
  const [typing, setTyping] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<number[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingInvite, setPendingInvite] = useState<any>(null);

  useEffect(() => {
    socket.emit("lobby:getHistory");

    const onHistory = (history: LobbyMessage[]) => {
      setMessages(history);

      history.forEach((msg) => {
        if (msg.user?.id !== user?.id) {
          socket.emit("lobby:read", {
            messageId: msg.id,
          });
        }
      });
    };
    const onMessage = (msg: LobbyMessage) => {
      setMessages((prev) => {
        if (msg.user && blockedUsers.includes(msg.user.id))
          return prev;

        return [...prev, msg];
      });

      if (msg.user?.id !== user?.id) {
        socket.emit("lobby:read", {
          messageId: msg.id,
        });
      }
    };

    const onSystem = (msg: LobbyMessage) => {
      setMessages((prev) => [
        ...prev,
        {
          ...msg,
          system: true,
        },
      ]);
    };

    const onTyping = () => {
      setTyping(true);

      if (typingTimeout.current) {
        clearTimeout(typingTimeout.current);
      }

      typingTimeout.current = setTimeout(() => {
        setTyping(false);
      }, 2000);
    };

    const onReadUpdate = (
      update: {
        id: number;
        expected_reads: number;
        read_by: number[];
      }
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === update.id
            ? {
                ...m,
                expected_reads: update.expected_reads,
                read_by: update.read_by,
              }
            : m
        )
      );
    };

    const onBlocked = ({ blockedUserId }: { blockedUserId: number }) => {
      setBlockedUsers((prev) => [...prev, blockedUserId]);

      setMessages((prev) =>
        prev.filter((m) => !m.user || m.user.id !== blockedUserId)
      );
    };

    const onInvite = (invite: any) => {
        if (!user)
          return;
        if (invite.to !== user.id)
          return;
        setPendingInvite(invite);
      };

    const onGameStart = ({
      gameId,
    }: {
      gameId: string;
    }) => {
      navigate(`/game/${gameId}`);
    };

    const onInviteExpired = () => {
      setPendingInvite(null);
      alert(t("chat.invitationExpired"));
    };

    const onInviteRejected = () => {
      alert(t("chat.invitationRejected"));
    };

    socket.on("lobby:history", onHistory);
    socket.on("lobby:message", onMessage);
    socket.on("lobby:system", onSystem);
    socket.on("lobby:typing", onTyping);
    socket.on("lobby:readUpdate", onReadUpdate);
    socket.on("lobby:userBlocked", onBlocked);
    socket.on("invite:received", onInvite);
    socket.on("game:start", onGameStart);
    socket.on("invite:expired", onInviteExpired);
    socket.on("invite:rejected", onInviteRejected);

    return () => {
      if (typingTimeout.current) {
        clearTimeout(typingTimeout.current);
      }
      socket.off("lobby:history", onHistory);
      socket.off("lobby:message", onMessage);
      socket.off("lobby:system", onSystem);
      socket.off("lobby:typing", onTyping);
      socket.off("lobby:readUpdate", onReadUpdate);
      socket.off("lobby:userBlocked", onBlocked);
      socket.off("invite:received", onInvite);
      socket.off("game:start", onGameStart);
      socket.off("invite:expired", onInviteExpired);
      socket.off("invite:rejected", onInviteRejected);
    };
  }, [blockedUsers, user]);

  const send = () => {
    const validation = validateText(message, {
      maxLength: 500,
      fieldName: t("chat.message"),
    });
    if (!validation.ok) {
      alert(validation.error);
      return;
    }
    socket.emit("lobby:send", {
      message: validation.value,
    });
    setMessage("");
  };

  const acceptInvite = () => {
    if (!pendingInvite)
      return;

    socket.emit("invite:accept", {
      inviteId: pendingInvite.id,
    });

    setPendingInvite(null);
  };

  const rejectInvite = () => {
    if (!pendingInvite)
      return;

    socket.emit("invite:reject", {
      inviteId: pendingInvite.id,
    });

    setPendingInvite(null);
  };

  const blockUser = (userId: number) => {
    socket.emit("lobby:blockUser", {
      blockedUserId: userId,
    });

    setSelectedMessageId(null);
  };

  const inviteUser = (userId: number) => {
    socket.emit("lobby:invite", {
      targetUserId: userId,
    });

    setSelectedMessageId(null);
  };

  const viewProfile = (userId: number) => {
    setSelectedMessageId(null);
    window.location.href = `/profile/${userId}`;
  };

  return (
    <div className="mt-6 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
      <h2 className="text-2xl font-bold mb-4">
        {t("chat.title")}
      </h2>

      <div className="h-96 overflow-y-auto rounded-xl bg-black/20 p-4 space-y-3">
        {messages.map((m) => {
          if (m.system) {
            return (
              <div
                key={m.id}
                className="text-center text-yellow-400 italic py-2"
              >
                {m.message}
              </div>
            );
          }
          if (!m.user)
	          return null;
          const chatUser = m.user;
          return (
            <div key={m.id} className="relative">

              <div className="flex items-center gap-3">
                <img
                  src={chatUser.avatar_url || "/uploads/default-avatar.png"}
                  alt={chatUser.username}
                  className="w-10 h-10 rounded-full object-cover border border-white/20 cursor-pointer"
                  onClick={() =>
                    setSelectedMessageId(
                      selectedMessageId === m.id ? null : m.id
                    )
                  }
                />

                <button
                  onClick={() =>
                    setSelectedMessageId(
                      selectedMessageId === m.id ? null : m.id
                    )
                  }
                  className="font-bold text-purple-300"
                >
                  {chatUser.username}
                </button>

                <span className="text-white/50">:</span>

                <div className="flex items-center gap-2">
                  <span className="break-words">
                    {m.message}
                  </span>

                  {chatUser.id === user?.id && (
                    <span className="text-xs text-white/50 select-none">
                      {m.read_by &&
                      m.expected_reads &&
                      m.read_by.length >= m.expected_reads
                        ? "✓✓"
                        : "✓"}
                    </span>
                  )}
                </div>
              </div>

              {selectedMessageId === m.id && (
                <div className="mt-2 ml-4 bg-black rounded p-2 flex gap-2">
                  <button
                      onClick={() => viewProfile(chatUser.id)}
                      className="bg-blue-500 px-2 py-1 rounded text-xs"
                  >
                      {t("chat.profile")}
                  </button>

                  <button
                      onClick={() => inviteUser(chatUser.id)}
                      className="bg-green-500 px-2 py-1 rounded text-xs"
                  >
                      {t("chat.invite")}
                  </button>

                  <button
                      onClick={() => blockUser(chatUser.id)}
                      className="bg-red-500 px-2 py-1 rounded text-xs"
                  >
                      {t("chat.block")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {typing && (
        <p className="text-xs text-white/50 mt-2">
            {t("chat.someoneTyping")}
        </p>
      )}

      {pendingInvite && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">

          <div className="bg-slate-900 rounded-2xl p-6 w-96 space-y-4">

            <h2 className="text-xl font-bold">
                {t("chat.gameInvitation")}
            </h2>

            <p>
                <strong>{pendingInvite.fromUsername}</strong>{" "}
                {t("chat.wantsToPlay")}
            </p>

            <div className="flex justify-end gap-3">

              <button
                onClick={rejectInvite}
                className="bg-red-600 px-4 py-2 rounded-lg"
              >
                {t("chat.reject")}
              </button>

              <button
                onClick={acceptInvite}
                className="bg-green-600 px-4 py-2 rounded-lg"
              >
                {t("chat.accept")}
              </button>

            </div>

          </div>

        </div>
      )}
      <div className="mt-2 text-right text-xs text-white/50">
        {message.length}/500
      </div>
      <div className="mt-4 flex gap-3">
        <input
          value={message}
          onChange={(e) => {
            const value = e.target.value;
            if (value.length <= 500) {
              setMessage(value);
              socket.emit("lobby:typing");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          className="flex-1 rounded-xl bg-white/10 px-4 py-3"
          placeholder={t("chat.writeMessage")}
        />

        <button
          onClick={send}
          className="rounded-xl bg-purple-500 px-6 py-3"
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}