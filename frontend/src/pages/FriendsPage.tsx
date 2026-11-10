import { useEffect, useState } from "react";
import MainLayout from "../layouts/MainLayout";
import GlassPanel from "../components/ui/GlassPanel";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";
import {getFriends, sendFriendRequest, removeFriend} from "../api/friends.api";
import { searchUsers } from "../api/user.api";
import { useFriendsStore } from "../store/friendsStore";
import { socket } from "../socket/socket";
import { validateText } from "../utils/validation";
import { useTranslation } from "react-i18next";

interface SearchUser {
  id: number;
  username: string;
  avatar_url?: string;
  online?: boolean;

  friendship_status:
    | "none"
    | "pending"
    | "received"
    | "accepted";
}

export default function FriendsPage() {
  const { friends, setFriends, updateOnlineStatus } = useFriendsStore();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);

  useEffect(() => {
    loadFriends();

    socket.on("presence:update", ({ userId, online }) => {
      updateOnlineStatus(userId, online);
    });

    return () => {
      socket.off("presence:update");
    };
  }, []);

  async function loadFriends() {
    try
    {
      const data = await getFriends();
      setFriends(data.friends);
    }
    catch
    {
      alert(t("friends.errors.load"));
    }
  }
  async function handleSearch() {
    const validation = validateText(query, {
      maxLength: 50,
      fieldName: t("friends.search"),
    });
    if (!validation.ok) {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      alert(validation.error);
      return;
    }
    try
    {
      const data = await searchUsers(validation.value);
      setResults(data.users);
    }
    catch (err)
    {
      if (err instanceof Error)
        alert(err.message);
      else
        alert(t("friends.errors.search"));
    }
  }

  async function handleSendRequest(userId: number) {
    try {
      await sendFriendRequest(userId);

      setResults((prev) =>
        prev.map((user) =>
          user.id === userId
            ? {
                ...user,
                friendship_status: "pending",
              }
            : user
        )
      );

      alert(t("friends.requestSent"));
    } catch (err) {
      if (err instanceof Error)
        alert(err.message);
      else
        alert(t("friends.errors.sendRequest"));
    }
  }

  async function handleRemoveFriend(friendId: number) {
    try
    {
      await removeFriend(friendId);
      await loadFriends();
    }
    catch (err)
    {
      if (err instanceof Error)
        alert(err.message);
      else
        alert(t("friends.errors.remove"));
    }
  }

  return (
    <MainLayout>
      <GlassPanel className="p-4 md:p-8 rounded-3xl border border-black/5 dark:border-white/10 my-4 shadow-xl">
        <h2 className="text-2xl md:text-3xl font-extrabold mb-6 tracking-tight text-textPrimary">
          {t("friends.title")}
        </h2>

        <div className="mb-8 bg-black/[0.03] dark:bg-white/5 border border-black/5 dark:border-white/5 rounded-2xl p-4 md:p-6 space-y-4">
          <h3 className="text-sm md:text-base font-semibold opacity-80 text-textPrimary">
            {t("friends.searchTitle")}
          </h3>

          <div className="flex flex-col sm:flex-row gap-3 items-stretch">
            <div className="flex-1 relative flex items-center">
              <Input
                placeholder={t("friends.searchPlaceholder")}
                value={query}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value.length <= 50) setQuery(value);
                }}
                className="w-full bg-white/50 dark:bg-slate-950/40 border border-black/10 dark:border-white/10 rounded-xl pr-14 py-3 text-textPrimary placeholder-textPrimary/40 focus:outline-none focus:border-purple-500"
              />
              <div className="absolute right-3 text-xs opacity-50 text-textPrimary pointer-events-none">
                {query.length}/50
              </div>
            </div>

            <Button
              onClick={handleSearch}
              className="px-6 py-3 bg-gradient-to-r from-pink-400 to-purple-400 hover:brightness-110 text-white rounded-xl font-bold transition-all sm:w-auto w-full flex-shrink-0"
            >
              {t("friends.searchButton")}
            </Button>
          </div>

          {results.length > 0 && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-black/10 dark:border-white/10">
              {results.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-3 rounded-xl bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative flex-shrink-0">
                      <img
                        src={user.avatar_url || "/uploads/default-avatar.png"}
                        className="w-10 h-10 rounded-full object-cover border border-black/10 dark:border-white/20"
                        alt={user.username}
                      />
                      <span
                        className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-white dark:border-slate-900 ${user.online ? "bg-green-500 shadow-[0_0_8px_#22c55e]" : "bg-zinc-400 dark:bg-zinc-500"}`}
                      />
                    </div>
                    <div className="truncate">
                      <p className="font-bold text-sm text-textPrimary truncate">
                        {user.username}
                      </p>
                      <p className="text-[10px] uppercase tracking-wider opacity-60 text-textPrimary font-medium">
                        {user.online
                          ? t("friends.online")
                          : t("friends.offline")}
                      </p>
                    </div>
                  </div>

                  <Button
                      disabled={user.friendship_status !== "none"}
                      className="px-4 py-1.5 text-xs bg-purple-500 hover:bg-purple-600 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg font-bold flex-shrink-0 transition-all shadow-md"
                      onClick={() => handleSendRequest(user.id)}
                  >
                      {
                          user.friendship_status === "accepted"
                              ? t("friends.friend")

                          : user.friendship_status === "pending"
                              ? t("friends.sent")

                          : user.friendship_status === "received"
                              ? t("friends.reply")

                          : t("friends.add")
                      }
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-textPrimary">
            {t("friends.myFriends")}
            <span className="text-xs font-bold bg-black/10 dark:bg-white/10 px-2.5 py-0.5 rounded-full text-textPrimary opacity-80">
              {friends.length}
            </span>
          </h3>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {friends.map((friend) => (
              <div
                key={friend.id}
                className="flex flex-row items-center p-4 rounded-2xl bg-black/[0.02] dark:bg-gradient-to-r dark:from-white/5 dark:to-white/[0.02] border border-black/5 dark:border-white/10 hover:border-purple-500/30 transition-all duration-300 shadow-sm backdrop-blur-sm md:grid md:grid-cols-3 md:gap-4"
              >
                <div className="flex items-center gap-3 min-w-0 md:justify-start">
                  <div className="relative flex-shrink-0">
                    <img
                      src={friend.avatar_url || "/uploads/default-avatar.png"}
                      className="w-11 h-11 rounded-full object-cover border border-black/10 dark:border-white/10 p-0.5 bg-white/10"
                      alt={`${t("friends.avatar")} ${friend.username}`}
                    />
                  </div>

                  <div className="min-w-0 flex flex-col justify-center">
                    <h4 className="font-bold text-sm md:text-base text-textPrimary truncate max-w-[120px] sm:max-w-none">
                      {friend.username}
                    </h4>
                    <p className="text-[11px] font-semibold tracking-wide md:hidden flex items-center gap-1 mt-0.5 text-green-600 dark:text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_6px_#22c55e]" />
                      {friend.online ? "En línea" : "Desconectado"}
                    </p>
                  </div>
                </div>
                <div className="hidden md:flex items-center justify-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${friend.online ? "bg-green-500 shadow-[0_0_8px_#22c55e]" : "bg-zinc-400 dark:bg-zinc-500"}`}
                  />
                  <span
                    className={`text-xs font-bold tracking-wide transition-colors ${friend.online ? "text-green-600 dark:text-green-400" : "opacity-50 text-textPrimary"}`}
                  >
                    {friend.online ? "En línea" : "Desconectado"}
                  </span>
                </div>
                <div className="ml-auto md:ml-0 flex justify-end md:justify-center lg:justify-end flex-shrink-0">
                  <Button
                    className="!w-20 md:!w-auto !min-w-0 h-8 px-0 md:px-4 text-[11px] md:text-xs !bg-red-500/10 hover:!bg-red-500/20 !text-red-600 dark:!text-red-400 !border !border-red-500/20 !bg-none rounded-xl font-bold transition-all duration-200 active:scale-95 flex items-center justify-center"
                    onClick={() => handleRemoveFriend(friend.id)}
                  >
                    {t("friends.remove")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </GlassPanel>
    </MainLayout>
  );
}
