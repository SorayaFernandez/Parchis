import { socket } from "../../socket/socket";
import { useGameStore } from "../../store/gameStore";

export function initGameSync(gameId: string, token: string) {
	const setGame = useGameStore.getState().setGame;

	socket.auth = { token };

	if (!socket.connected) {
		socket.connect();
	}

	socket.emit("game:join", { gameId });

	socket.on("game:update", (game) => {
		setGame(game);
	});
}