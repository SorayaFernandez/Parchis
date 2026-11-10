import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createGame, joinGame } from "../api/game.api";
import { useAuth } from "../context/AuthContext";
import LobbyChat from "../components/ui/LobbyChat";
import Footer from "../components/ui/Footer";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../i18n/LanguageSwitcher";

function LobbyPage() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const { t } = useTranslation();

  const [gameId, setGameId] = useState("");
  const [loadingCreate, setLoadingCreate] = useState(false);
  const [loadingJoin, setLoadingJoin] = useState(false);

  const handleLogout = () => {
    sessionStorage.removeItem("token");
    navigate("/");
  };

  const handleCreateGame = async () => {
    try
    {
      if (!token)
        return;
      setLoadingCreate(true);
      const game = await createGame(token);
      if (game.message)
      {
        alert(game.message);
        return;
      }
      if (game.id)
      {
        navigate(`/game/${game.id}`);
      }
    }
    catch (err)
    {
      if (err instanceof Error)
      {
        if (err.message === "Already in a game")
        {
          alert(t("lobby.activeGame"));
          return;
        }

        alert(err.message);
        return;
      }

      alert(t("lobby.createError"));
    }
    finally
    {
      setLoadingCreate(false);
    }
  };

  const handleJoinGame = async () => {
    try
    {
      if (!token)
        return;

      if (!gameId.trim())
      {
        alert(t("lobby.enterGameId"));
        return;
      }
      setLoadingJoin(true);
      const game = await joinGame(token, gameId.trim());
      if (game.success === false)
      {
        alert(game.error);
        return;
      }
      if (game.id)
      {
        navigate(`/game/${game.id}`);
      }
    }
    catch (err)
    {
      alert(
          err instanceof Error
              ? err.message
              : t("lobby.joinError")
      );
    }
    finally
    {
      setLoadingJoin(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 md:p-6 text-white flex flex-col gap-6">
      <div className="mx-auto w-full max-w-7xl flex flex-col md:flex-row gap-4 md:gap-0 items-center justify-between rounded-3xl border border-white/10 bg-white/5 p-5 md:p-6 backdrop-blur-xl">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-pink-300 via-purple-300 to-blue-300 bg-clip-text text-transparent text-center md:text-left">
            {t("app.title")}
          </h1>
        </div>
        <div className="flex flex-wrap justify-center gap-4 md:gap-6 items-center text-sm md:text-base">
          <LanguageSwitcher />

          <button
            className="hover:text-purple-300 transition-colors"
            onClick={() => {
              if (user) navigate(`/profile/${user.id}`);
            }}
          >
            {t("menu.profile")}
          </button>

          <button
            className="hover:text-purple-300 transition-colors"
            onClick={() => navigate("/friends")}
          >
            {t("menu.friends")}
          </button>

          <button
            className="hover:text-purple-300 transition-colors"
            onClick={() => navigate("/friend-requests")}
          >
            {t("menu.requests")}
          </button>

          <button
            onClick={handleLogout}
            className="rounded-xl bg-red-500/10 px-4 py-2 text-red-200 hover:bg-red-500/20 transition-all text-xs md:text-sm"
          >
            {t("menu.logout")}
          </button>
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl rounded-3xl border border-white/10 bg-white/5 p-6 md:p-10 backdrop-blur-xl">
        {/* CAMBIO CLAVE: flex-col en móvil, flex-row en pantallas grandes (lg:) para balancear el espacio */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
          {/* COLUMNA IZQUIERDA: Título de Bienvenida */}
          <div className="max-w-xl text-center lg:text-left">
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-white to-purple-200 bg-clip-text text-transparent">
              {t("lobby.welcome")}
            </h2>
          </div>

          {/* COLUMNA DERECHA: Acciones (Crear / Unirse) */}
          {/* Limitamos el ancho en PC (lg:max-w-md) para que los botones no se estiren infinitamente y se vean elegantes */}
          <div className="w-full lg:max-w-md flex flex-col gap-4">
            {/* Botón de Crear Partida */}
            <button
              onClick={handleCreateGame}
              disabled={loadingCreate}
              className="
          w-full
          rounded-2xl 
          bg-gradient-to-r from-pink-400 to-purple-400 
          px-6 py-4 
          font-bold 
          shadow-lg shadow-purple-500/20 
          active:scale-98 
          transition-all duration-200
          hover:brightness-110
          disabled:opacity-50
          text-sm md:text-base
        "
            >
              {
                  loadingCreate
                      ? t("lobby.creating")
                      : t("lobby.createGame")
              }
            </button>

            {/* Inputs de Unirse a Partida */}
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
                placeholder={t("lobby.gameId")}
                className="
            flex-1 
            rounded-xl 
            border border-white/10 
            bg-white/5 
            px-4 py-3 
            text-white 
            placeholder-white/40 
            focus:outline-none focus:border-purple-500 focus:bg-white/10
            transition-all duration-200 
            text-sm md:text-base
          "
              />
              <button
                onClick={handleJoinGame}
                disabled={loadingJoin}
                className="
            rounded-xl 
            border border-white/10 
            bg-white/10 
            px-6 py-3 sm:py-2 
            font-semibold 
            hover:bg-white/20 
            active:scale-98
            transition-all duration-200 
            disabled:opacity-50 
            text-sm md:text-base
          "
              >
                {
                    loadingJoin
                        ? t("lobby.joining")
                        : t("lobby.join")
                }
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl">
        <LobbyChat />
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
        <Footer />
      </div>
    </div>
  );
}

export default LobbyPage;
