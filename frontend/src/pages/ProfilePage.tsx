import {useEffect, useState} from "react";
import MainLayout from "../layouts/MainLayout";
import {getMe, getUserById, updateProfile} from "../api/user.api";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import GlassPanel from "../components/ui/GlassPanel";
import { useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import type { User } from "../types/user";
import { useTranslation } from "react-i18next";

export default function ProfilePage() {
    const [user, setUser] = useState<User | null>(null);
	const [editing, setEditing] = useState(false);
	const [username, setUsername] = useState("");

	const avatars = [
		"/uploads/default-avatar.png",
		"/uploads/default-avatar1.png",
		"/uploads/default-avatar2.png",
		"/uploads/default-avatar3.png",
		"/uploads/default-avatar4.png",
		"/uploads/default-avatar5.png",
		"/uploads/default-avatar6.png",
		"/uploads/default-avatar7.png",
		"/uploads/default-avatar8.png",
		"/uploads/default-avatar9.png",
	];

	const { id } = useParams();
	const { user: me } = useAuth();
    const { t } = useTranslation();
	const [selectedAvatar, setSelectedAvatar] = useState("");

	const isMyProfile = Number(id) === me?.id;

	useEffect(() => {
		loadProfile();
	}, [id, me]);

	async function loadProfile() {
		try {
			let data;

			if (isMyProfile)
				data = await getMe();
			else
				data = await getUserById(id!);

			setSelectedAvatar(
				data.avatar_url ||
				"/uploads/default-avatar.png"
			);

			setUser(data);
			setUsername(data.username);
		}
		catch
		{
			alert(t("profile.loadError"));
		}
	}

	async function handleSave() {
		if (!isMyProfile)
			return;

		const cleanUsername = username.trim();

		if (!cleanUsername) {
			alert(t("profile.validation.required"));
			return;
		}

		if (cleanUsername.length < 3 || cleanUsername.length > 20) {
			alert(t("profile.validation.length"));
			return;
		}

		if (!avatars.includes(selectedAvatar)) {
			alert(t("profile.validation.invalidAvatar"));
			return;
		}

		try
		{
			await updateProfile(cleanUsername, selectedAvatar);
			await loadProfile();
			setEditing(false);
		}
		catch (err)
		{
			const message =
                err instanceof Error
                    ? err.message
                    : t("profile.validation.updateError");
			alert(message);
		}
	}

	if (!user) {
		return (
			<MainLayout>
				<div>{t("profile.loading")}</div>
			</MainLayout>
		);
	}

	return (
		<MainLayout>
            <GlassPanel className="max-w-xl mx-auto p-5 md:p-8 rounded-3xl border border-white/10 my-4 md:my-8">
                <h2 className="text-xl md:text-2xl font-bold mb-6 text-center md:text-left tracking-wide">
                {
                    isMyProfile
                        ? t("profile.title.mine")
                        : t("profile.title.user", {
                            username: user.username,
                        })
                }
                </h2>
                {editing && isMyProfile ? (
                    <div className="space-y-6">
                        <div>
                            <span className="block text-sm font-medium text-black/60 mb-3">
                                {t("profile.edit.title")}
                            </span>
                            <div className="grid grid-cols-4 sm:grid-cols-5 gap-3 max-w-md mx-auto">
                                {avatars.map((avatar) => (
                                    <img
                                        key={avatar}
                                        src={avatar}
                                        onClick={() => setSelectedAvatar(avatar)}
                                        className={`
                                            w-12 h-12 sm:w-16 sm:h-16 rounded-full cursor-pointer border-2 object-cover
                                            transition-all duration-200 hover:scale-110 active:scale-95
                                            ${selectedAvatar === avatar
                                                ? "border-cyan-400 shadow-lg shadow-cyan-400/20"
                                                : "border-white/10 hover:border-white/30"
                                            }
                                        `}
                                        alt={t("profile.avatarAlt.option")}
                                    />
                                ))}
                            </div>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-black/60 mb-2">
                                    {t("profile.edit.username")}
                                </label>
                                <Input
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="w-full bg-white/5 border-white/10 rounded-xl px-4 py-3"
                                />
                            </div>

                            <Button
                                onClick={handleSave}
                                className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-700 font-bold transition-all"
                            >
                                {t("profile.edit.save")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center md:items-stretch gap-6">
                        <div className="flex justify-center">
                            <div className="relative">
                                <img
                                    src={selectedAvatar || "/uploads/default-avatar.png"}
                                    className={`
                                        w-24 h-24
                                        md:w-28 md:h-28
                                        rounded-full
                                        object-cover
                                        p-1
                                        bg-white/5
                                        border-[3px]
                                        transition-all
                                        duration-300
                                        ${
                                            user.online
                                                ? "border-green-500 shadow-[0_0_18px_rgba(34,197,94,0.45)]"
                                                : "border-purple-500/30"
                                        }
                                    `}
                                    alt={t("profile.avatarAlt.current")}
                                />
                            </div>
                        </div>
                        <div className="w-full space-y-3 bg-white/5 border border-white/5 rounded-2xl p-5">
                            <div className="flex justify-between items-center border-b border-white/5 pb-2 text-sm md:text-base">
                                <span className="text-gray/50">{t("profile.info.username")}</span>
                                <span className="font-semibold text-gray/20">{user.username}</span>
                            </div>

                            {isMyProfile && (
                                <div className="flex justify-between items-center border-b border-white/5 pb-2 text-sm md:text-base">
                                    <span className="text-gray/50">{t("profile.info.email")}</span>
                                    <span className="font-semibold text-gray/20 break-all pl-4 text-right">{user.email}</span>
                                </div>
                            )}

                            <div className="flex justify-between items-center text-sm md:text-base">
                                <span className="text-gray/50">{t("profile.info.createdAt")}</span>
                                <span className="font-semibold text-gray/20">
                                    {new Date(user.created_at).toLocaleDateString()}
                                </span>
                            </div>
                        </div>
                        {isMyProfile && (
                            <Button
                                onClick={() => setEditing(true)}
                                className="w-full py-3 rounded-xl bg-white/10 hover:bg-white/20 font-bold transition-all mt-2 text-sm md:text-base"
                            >
                                {t("profile.edit.button")}
                            </Button>
                        )}
                    </div>
                )}
            </GlassPanel>
        </MainLayout>
	);
}
