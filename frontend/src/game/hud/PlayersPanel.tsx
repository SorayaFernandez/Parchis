import type { Game } from "../../types/game";
import { useTranslation } from "react-i18next";

export default function PlayersPanel({ game }: { game: Game }) {

  const { t } = useTranslation();

  const avatarBorderColors = {
    pink: "border-pink-500",
    purple: "border-purple-500",
    blue: "border-blue-500",
    green: "border-green-500",
  };

  return (
    <div className="
      rounded-3xl
      p-4
      flex
      flex-col
      gap-3
    ">
      <h3 className="font-bold mb-2">
        {t("players.title")}
      </h3>

      {game.players.map((p) => {
        const isTurn = game.turn === p.id;

        return (
          <div
            key={p.id}
            className={`
              rounded-2xl
              p-3
              flex
              items-center
              gap-3
              border

              ${isTurn
                ? "border-cyan-400 shadow-[0_0_25px_rgba(34,211,238,.3)]"
                : "border-white/5"
              }
            `}
          >
            <img
              src={p.avatar_url || "/uploads/default-avatar.png"}
              alt={p.username}
              className={`
                w-14
                h-14
                rounded-full
                object-cover
                border-2
                ${
                  isTurn
                    ? `${avatarBorderColors[p.color]} shadow-[0_0_15px_rgba(255,255,255,.25)]`
                    : avatarBorderColors[p.color]
                }
              `}
            />

            <div className="flex-1">
              <div className="font-semibold capitalize">
                {p.username}
              </div>

              <div className="text-xs text-white/50">
                {p.abandoned
                  ? t("players.abandoned")
                  : p.connected
                  ? t("players.connected")
                  : t("players.disconnected")}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}