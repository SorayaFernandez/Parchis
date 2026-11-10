import { useEffect, useState } from "react";
import MainLayout from "../layouts/MainLayout";
import GlassPanel from "../components/ui/GlassPanel";
import Button from "../components/ui/Button";
import type { FriendRequest } from "../types/friend";
import { getPendingRequests, acceptFriendRequest } from "../api/friends.api";
import { useTranslation } from "react-i18next";

export default function FriendRequestsPage() {
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const { t } = useTranslation();

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    try {
      const data = await getPendingRequests();
      setRequests(data.requests);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleAccept(id: number) {
    try {
      await acceptFriendRequest(id);
      loadRequests();
    } catch (err) {
      console.error(err);
      alert(t("friendRequests.errors.accept"));
    }
  }

  return (
    <MainLayout>
      <GlassPanel className="p-4 md:p-8 rounded-3xl border border-black/5 dark:border-white/10 my-4 shadow-xl">
        <h2 className="text-2xl md:text-3xl font-extrabold mb-6 tracking-tight text-textPrimary">
          {t("friendRequests.title")}
          {requests.length > 0 && (
            <span className="ml-2 text-xs font-bold bg-purple-500/10 text-purple-600 dark:text-purple-400 px-2.5 py-0.5 rounded-full">
              {requests.length}
            </span>
          )}
        </h2>

        {requests.length === 0 ? (
          <div className="text-center py-8 opacity-50 text-textPrimary text-sm font-medium">
            {t("friendRequests.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {requests.map((request) => (
              <div
                key={request.senderId}
                className="flex flex-row items-center p-4 rounded-2xl bg-black/[0.02] dark:bg-gradient-to-r dark:from-white/5 dark:to-white/[0.02] border border-black/5 dark:border-white/10 hover:border-purple-500/30 transition-all duration-300 shadow-sm backdrop-blur-sm md:grid md:grid-cols-3 md:gap-4"
              >
                <div className="flex items-center gap-3 min-w-0 md:justify-start flex-1">
                  <div className="relative flex-shrink-0">
                    <img
                      src={(request as any).senderAvatarUrl || "/uploads/default-avatar.png"}
                      className="w-11 h-11 rounded-full object-cover border border-black/10 dark:border-white/10 p-0.5 bg-white/10"
                      alt={`${t("friends.avatar")} ${request.senderUsername}`}
                    />
                  </div>

                  <div className="min-w-0 flex flex-col justify-center">
                    <h4 className="font-bold text-sm md:text-base text-textPrimary truncate max-w-[120px] sm:max-w-none">
                      {request.senderUsername}
                    </h4>
                    <p className="text-[11px] font-medium opacity-50 text-textPrimary md:hidden mt-0.5">
                      {t("friendRequests.sentYou")}
                    </p>
                  </div>
                </div>

                <div className="hidden md:flex items-center justify-center">
                  <span className="text-xs font-semibold opacity-50 text-textPrimary tracking-wide">
                    {t("friendRequests.pending")}
                  </span>
                </div>

                <div className="ml-auto md:ml-0 flex justify-end md:justify-center lg:justify-end flex-shrink-0">
                  <Button
                    className="
                      !w-20 md:!w-auto !min-w-0 h-8 px-0 md:px-4 
                      text-[11px] md:text-xs 
                      !bg-purple-500/10 hover:!bg-purple-500/20 
                      !text-purple-600 dark:!text-purple-300
                      !border !border-purple-500/20
                      !bg-none 
                      rounded-xl 
                      font-bold 
                      transition-all duration-200 
                      active:scale-95 
                      flex items-center justify-center
                    "
                    onClick={() => handleAccept(request.senderId)}
                  >
                    {t("friendRequests.accept")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </MainLayout>
  );
}