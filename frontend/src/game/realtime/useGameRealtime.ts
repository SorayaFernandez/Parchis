import { useEffect, useRef } from "react";
import { socket, connectSocket } from "../../socket/socket";
import { useGameStore } from "../../store/gameStore";

export function useGameRealtime(gameId: string, token: string)
{
  const setGame = useGameStore((s) => s.setGame);
  const clearGame = useGameStore((s) => s.clear);
  const joinedRef = useRef<string | null>(null);
  const leavingRef = useRef(false);
  const setShowLastPlayerPopup =
	useGameStore(s => s.setShowLastPlayerPopup);

  useEffect(() => {
    if (!gameId || !token) {
      return;
    }

    connectSocket(token);

    clearGame();

    const onUpdate = (game: any) => {setGame(game)};
    const onLastPlayer = () => {setShowLastPlayerPopup(true)};

    const leaveGame = () => {
      if (!gameId)
        return;
      if (leavingRef.current)
        return;
      leavingRef.current = true;
      socket.emit("game:leave", {gameId});
    };

    socket.off("game:update", onUpdate);
    socket.on("game:update", onUpdate);
    socket.off("game:last_player", onLastPlayer);
    socket.on("game:last_player", onLastPlayer);
    window.addEventListener("beforeunload", leaveGame);

    if (joinedRef.current !== gameId)
    {
      joinedRef.current = gameId;
      leavingRef.current = false;
      socket.emit("game:join", {gameId});
      socket.emit("game:state", {gameId});
    }

    return () => {
      leaveGame();
      window.removeEventListener("beforeunload", leaveGame);
      socket.off("game:update", onUpdate);
    };
  }, [
    gameId,
    token,
    setGame,
    clearGame,
  ]);
}