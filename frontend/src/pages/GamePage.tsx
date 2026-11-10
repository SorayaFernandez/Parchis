import { useState } from "react";
import { useGameRealtime } from "../game/realtime/useGameRealtime";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useGameStore } from "../store/gameStore";
import { rollDice, movePiece, moveBonusPiece } from "../api/game.api";
import GameScene from "../game/layout/GameScene";
import Footer from "../components/ui/Footer";
import PlayersPanel from "../game/hud/PlayersPanel";
import ChatPanel from "../game/hud/ChatPanel";
import GameHUD from "../game/hud/GameHUD";
import { socket } from "../socket/socket";
import VictoryAnimation from "../game/animations/VictoryAnimation";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../i18n/LanguageSwitcher";
import { motion } from "framer-motion";
import SpectatorsPanel from "../game/hud/SpectatorsPanel";

export default function GamePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { token, user } = useAuth();
  const game = useGameStore((s) => s.game);
  const gameFinished = game?.status === "finished";
  const hasWon = gameFinished && game?.winner === user?.id;
  const winner = game?.players.find(p => p.id === game?.winner);
  const showLastPlayerPopup = useGameStore((s) => s.showLastPlayerPopup);
  const setShowLastPlayerPopup = useGameStore((s) => s.setShowLastPlayerPopup);
  const { t } = useTranslation();
  const [rolling, setRolling] = useState(false);
  const errorMap: Record<string, string> = {
    "Roll dice first": "game.errors.rollDiceFirst",
    "Not your turn": "game.errors.notYourTurn",
    "Invalid move": "game.errors.invalidMove",
    "Need 5 to leave base": "game.errors.needFive",
    "Own blockade on exit": "game.errors.ownBlockade",
    "Exact roll required": "game.errors.exactRoll",
    "Blockade in path": "game.errors.blockadePath",
    "Destination blocked by blockade": "game.errors.destinationBlocked",
  };

  useGameRealtime(id ?? "", token ?? "");

  const isSpectator = !!(
    game && !game.players.some((p: any) => p.id === user?.id)
  );

  const currentUserPlayer = game?.players.find(
    (p) => p.id === user?.id
  );

  const currentTurnPlayer = game?.players.find(
    (p) => p.id === game?.turn
  );

  const avatarBorderColors = {
    pink: "border-pink-400 shadow-pink-500/30",
    purple: "border-purple-400 shadow-purple-500/30",
    blue: "border-sky-400 shadow-sky-500/30",
    green: "border-green-400 shadow-green-500/30",
  };

  const handleRoll = async () => {
    if (!token || !id || isSpectator)
      return;

    setRolling(true);

    try
    {
      const result = await rollDice(token, id);

      if (!result.success)
      {
        alert(result.error);
        return;
      }
    }
    finally
    {
      setTimeout(() => setRolling(false), 500);
    }
  };

  const [moving, setMoving] = useState(false);

  const handleMove = async (index: number) => {
    if (!token || !id || isSpectator || !game || moving)
      return;
    setMoving(true);

    try
    {
      if (game.pendingBonus != null)
        await moveBonusPiece(token, id, index);
      else
        await movePiece(token, id, index);
    }
    catch (err)
    {
        if (!(err instanceof Error))
        {
            console.error(err);
            return;
        }

        const key = errorMap[err.message];
        if (key)
        {
          alert(t(key));
          return;
        }

        console.error(err);
    }
    finally
    {
      setMoving(false);
    }
  };

  const handleLeave = () => {
    if (id) {
      socket.emit("game:leave", {
        gameId: id,
      });
    }
    navigate("/lobby");
  };

  const handleLastPlayerConfirm = () => {
    setShowLastPlayerPopup(false);

    if (id) {
      socket.emit("game:leave", {
        gameId: id,
      });
    }

    navigate("/lobby");
  };

  if (!game) {
    return (
      <div className="text-white p-6">
        {t("game.loading")}
      </div>
    );
  }

  return (

    <div className="relative h-screen overflow-hidden bg-slate-950 text-white flex flex-col">
        
      {/* Fondo decorativo */}
      <div className="absolute inset-0 -z-0 overflow-hidden">

        {/* Rosa - esquina superior izquierda */}
        <div className="
          absolute
          -top-40
          -left-40
          h-[980px]
          w-[980px]
          rounded-full
          bg-pink-500/40
          blur-[350px]
        " />

        {/* Verde - esquina superior derecha */}
        <div className="
          absolute
          -top-40
          -right-40
          h-[980px]
          w-[980px]
          rounded-full
          bg-green-500/40
          blur-[350px]
        " />

        {/* Azul - esquina inferior izquierda */}
        <div className="
          absolute
          -bottom-40
          -left-40
          h-[980px]
          w-[980px]
          rounded-full
          bg-sky-500/40
          blur-[350px]
        " />

        {/* Morado - esquina inferior derecha */}
        <div className="
          absolute
          -bottom-40
          -right-40
          h-[980px]
          w-[980px]
          rounded-full
          bg-purple-500/40
          blur-[350px]
        " />

      </div>

      {/* Botón Flotante para Móvil del HUD (Chat/Dados/Players) */}
      <div className="block md:hidden">
        <GameHUD
          game={game}
          onRoll={handleRoll}
          rolling={rolling}
          isSpectator={isSpectator}
        />
      </div>

      {/* Contenedor Principal */}
      <div className="relative z-10 flex-1 min-h-0 flex flex-col md:flex-row p-4 md:p-6 gap-6 items-stretch">
         
        {/* PANEL IZQUIERDO */}
        <div className="hidden xl:flex w-72 flex-col gap-6">

          {/* Logo */}
          <h1
            className="
              text-7xl
              font-extrabold
              leading-none
              tracking-tight
              bg-gradient-to-r
              from-pink-300
              via-purple-300
              to-blue-300
              bg-clip-text
              text-transparent
            "
          >
            {t("app.title")}
          </h1>

          {/* Perfil del jugador */}
          {currentUserPlayer && (
            <div
              className="
                rounded-3xl
                border
                border-white/10
                bg-white/5
                backdrop-blur-xl
                p-5
                shadow-xl
                shadow-purple-500/10
              "
            >
              <div className="flex flex-col items-center text-center">

                <img
                  src={currentUserPlayer.avatar_url}
                  alt={currentUserPlayer.username}
                  className={`
                    w-24
                    h-24
                    rounded-full
                    object-cover
                    border-4
                    shadow-lg
                    ${
                      avatarBorderColors[
                        currentUserPlayer.color as keyof typeof avatarBorderColors
                      ]
                    }
                  `}
                />

                <p className="mt-4 text-xs uppercase tracking-[0.3em] text-white/40">
                  {t("game.you")}
                </p>

                <h2 className="mt-1 text-3xl font-extrabold text-white break-all">
                  {currentUserPlayer.username}
                </h2>

                <div className="mt-3 rounded-full bg-emerald-500/20 border border-emerald-500/30 px-4 py-1">
                  <span className="text-sm font-semibold text-emerald-300">
                    {t("game.playing")}
                  </span>
                </div>

              </div>
            </div>
          )}

          <SpectatorsPanel
            spectators={game.spectators ?? []}
          />

        </div>

        {/* LADO IZQUIERDO: El Escenario del Juego */}
        <div className="flex-1 flex flex-col gap-4">

          <div className="flex-1 flex items-center justify-center relative bg-white/5 backdrop-blur-md rounded-3xl border border-white/5 p-4 min-h-[65vh] md:min-h-0">

            <button
              onClick={handleLeave}
              className="
                absolute top-4 left-4 z-50
                rounded-2xl
                border border-white/10
                bg-white/10
                backdrop-blur-xl
                px-5 py-2.5
                font-medium
                text-white/80
                shadow-xl
                transition-all duration-200
                hover:bg-red-500/15
                hover:border-red-400/30
                hover:text-red-300
                hover:shadow-red-500/20
                hover:shadow-xl
              "
            >
              {t("game.leave")}
            </button>

            <div className="absolute top-4 right-4 z-50">
              <LanguageSwitcher />
            </div>

            {isSpectator && (
              <div className="absolute top-16 md:top-20 left-4 z-50 bg-yellow-500/20 text-yellow-300 px-3 py-1.5 rounded-xl text-xs font-semibold">
                {t("game.spectatorMode")}
              </div>
            )}

            {showLastPlayerPopup && (
              <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4">
                <div className="bg-slate-950 border border-white/10 rounded-2xl p-8 w-full max-w-md shadow-2xl">
                  <h2 className="text-xl md:text-2xl font-bold mb-3 text-purple-400">
                    {t("game.abandoned.title")}
                  </h2>
                  <p className="text-white/70 mb-6 text-sm">
                    {t("game.abandoned.message")}
                  </p>
                  <button
                    onClick={handleLastPlayerConfirm}
                    className="w-full rounded-xl bg-purple-600 py-3 font-bold hover:bg-purple-700 transition"
                  >
                    {t("game.abandoned.confirm")}
                  </button>
                </div>
              </div>
            )}

            {
                gameFinished && (
                    <VictoryAnimation
                        won={hasWon}
                        isSpectator={isSpectator}
                        winnerName={winner?.username ?? ""}
                        onClose={handleLeave}
                    />
                )
            }

            <GameScene
              game={game}
              onPieceClick={(playerId: number, pieceIndex: number) => {
                if (isSpectator)
                  return;
                const currentPlayer = game.players.find((p: any) => p.id === game.turn);
                if (!currentPlayer)
                  return;
                if (currentPlayer.id !== playerId)
                  return;
                if (game.status !== "playing")
                    return;
                if (game.players.length < 2)
                    return;
                if (game.turn !== user?.id)
                    return;
                if (playerId !== user?.id)
                    return;
                if (game.pendingBonus == null && game.dice == null)
                    return;
                const player = game.players.find((p: any) => p.id === playerId);
                if (!player)
                    return;
                const piece = player.pieces[pieceIndex];
                if (!piece)
                    return;
                const steps = game.pendingBonus ?? game.dice;
                if (piece.state === "base" && steps !== 5)
                    return;
                if (!game.availableMoves?.includes(pieceIndex))
                    return;
                handleMove(pieceIndex);
              }}
            />
          </div>
        </div>

        {/* LADO DERECHO: El Panel Lateral Organizado (Solo visible en PC) */}
        <div className="hidden md:flex w-108 flex-col gap-4 min-h-0">
          
          {/* Cabecera del juego */}
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4">
            <h1 className="text-lg font-bold text-yellow-100 drop-shadow-[0_0_3px_rgba(255,255,180,0.25)]">
              {t("game.header.title", { id: game.id })}
            </h1>
            <div className="flex justify-between text-xs text-white/50 mt-1">
              <div>
                {t("game.header.turn")}:{" "}
                <span className="font-semibold text-white">
                  {currentTurnPlayer?.username ?? "-"}
                </span>
              </div>

              <div>
                {t("game.header.spectators", {
                  count: game.spectators?.length || 0,
                })}
              </div>
            </div>
          </div>

          {/* Tus componentes HUD directamente integrados en el flujo de la columna en PC */}
          <PlayersPanel game={game} />
          
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4 flex flex-col gap-3">
            <div className="p-6 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
              {game.dice == null ? (
                <span className="text-5xl">🎲</span>
              ) : (
                <motion.img
                  key={game.dice}
                  src={`/ui/dice-${game.dice}.svg`}
                  alt={`Dice ${game.dice}`}
                  className="w-24 h-24 object-contain"
                  animate={
                    rolling
                      ? {
                          rotate: [0, -25, 25, -15, 15, 0],
                          scale: [1, 1.25, 1],
                        }
                      : {
                          rotate: 0,
                          scale: 1,
                        }
                  }
                  transition={{
                    duration: 0.5,
                    ease: "easeInOut",
                  }}
                />
              )}

              {game.pendingBonus && (
                <span className="text-2xl font-bold text-yellow-400 animate-pulse ml-2">
                  +{game.pendingBonus}
                </span>
              )}
            </div>

            <button
                disabled={isSpectator || game.pendingBonus != null}
                onClick={handleRoll}
                className={`
                  w-full
                  rounded-2xl
                  px-6
                  py-4
                  font-bold
                  transition-all
                  duration-200
                  text-sm
                  md:text-base
                  ${
                    isSpectator || game.pendingBonus != null
                      ? "bg-gray-600/50 text-white/40 cursor-not-allowed"
                      : `
                        bg-gradient-to-r
                        from-pink-400
                        to-purple-400
                        text-white
                        shadow-lg
                        shadow-purple-500/20
                        hover:brightness-110
                        active:scale-95
                      `
                  }
                `}
              >
              {isSpectator
                ? t("game.dice.spectating")
                : t("game.dice.roll")}
            </button>
          </div>

          <ChatPanel game={game} />
        </div>

      </div>

      <div className="px-6 py-2">
        <Footer />
      </div>
    </div>
  );
}
