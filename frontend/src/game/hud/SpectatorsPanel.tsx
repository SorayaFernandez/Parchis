import type { Spectator } from "../../types/game";
import { useTranslation } from "react-i18next";

type Props = {
  spectators: Spectator[];
};

export default function SpectatorsPanel({ spectators }: Props) {
  const { t } = useTranslation();

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4">
      <h2 className="text-sm font-bold text-white mb-3">
        {t("spectators.title")} ({spectators.length})
      </h2>

      {spectators.length === 0 ? (
        <p className="text-white/40 text-sm">
          {t("spectators.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {spectators.map((spectator) => (
            <div
              key={spectator.id}
              className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2 border border-white/5"
            >
              <img
                src={spectator.avatar_url ?? "/uploads/default-avatar.png"}
                alt={spectator.username}
                className="w-10 h-10 rounded-full object-cover border border-white/20"
              />

              <span className="text-white text-sm font-medium truncate">
                {spectator.username}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}