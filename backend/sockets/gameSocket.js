const {getGame, saveGame, deleteGame} = require('../game/gameManager');
const setPlayerConnection = require('../game/rules/setPlayerConnection');
const checkPausedState = require('../game/rules/checkPausedState');
const isGameAbandoned = require('../game/rules/isGameAbandoned');
const normalizeGame = require('../game/utils/normalizeGame');
const withGameLock = require('../game/withGameLock');
const {clearDisconnectTimer, setDisconnectTimer} = require('../game/disconnectTimers');
const {DISCONNECT_TIMEOUT} = require('../game/constants');

async function disconnectPlayer(io, gameId, userId) {
	const locked = await withGameLock(gameId, async (game) => {
		if (!game)
			return { error: "Game not found" };
		setPlayerConnection(game, userId, false);
		checkPausedState(game);
		return { ok: true };
	});

	if (!locked)
		return;
	const normalized = await normalizeGame(locked.game);
	io.to(String(gameId)).emit("game:update", normalized);
	io.to(String(gameId)).emit("game:player_disconnected", {
		userId
	});

	const timer = setTimeout(async () => {
		await withGameLock(gameId, async (game) => {
			if (!game)
				return { error: "Game not found" };
			const player = game.players.find(p => p.id === userId);
			if (!player)
				return { ok: true };
			if (player.connected)
				return { ok: true };
			player.abandoned = true;
			checkPausedState(game);
			const activePlayers = game.players.filter(p => !p.abandoned);
			if (activePlayers.length === 1)
			{
				const lastPlayer = activePlayers[0];
				game.status = "finished";
				game.winner = lastPlayer.id;
				game.updatedAt = Date.now();
				const room = io.sockets.adapter.rooms.get(String(gameId));
				if (room)
				{
					for (const socketId of room)
					{
						const s = io.sockets.sockets.get(socketId);
						if (s?.user?.id === lastPlayer.id)
						{
							s.emit("game:last_player");
							break;
						}
					}
				}
				return { ok: true };
			}
			if (isGameAbandoned(game))
			{
				return { deleteGame: true };
			}
			return { ok: true };
		});
		const game = await getGame(gameId);
		if (game)
		{
			io.to(gameId).emit("game:update", await normalizeGame(game));
		}
		}, DISCONNECT_TIMEOUT);
	setDisconnectTimer(gameId, userId, timer);
}

function registerGameSocket(io, socket)
{
	socket.on('game:join', async ({ gameId }) => {
		try
		{
			if (socket.rooms.has(String(gameId)))
				return;

			socket.join(String(gameId));
			clearDisconnectTimer(gameId, socket.user.id);

			const locked = await withGameLock(gameId, async (game) => {
				const player = game.players.find(p => p.id === socket.user.id);

				if (player)
				{
					setPlayerConnection(game, socket.user.id, true);
					checkPausedState(game);
					return { ok: true };
				}

				if (game.status === 'finished')
					return { error: 'Game finished' };

				if (!game.spectators)
					game.spectators = [];

				const alreadySpectator = game.spectators.includes(socket.user.id);

				if (!alreadySpectator)
					game.spectators.push(socket.user.id);

				return {
					ok: true,
					spectator: true
				};
			});

			if (!locked)
				return socket.emit('error', { message: 'Game not found' });

			if (locked.result.error)
				return socket.emit('error', { message: locked.result.error });

			const normalized = await normalizeGame(locked.game);
			socket.emit('game:update', normalized);
			io.to(String(gameId)).emit('game:update', normalized);
		}
		catch (err)
		{
			console.error('game:join error:', err);
			socket.emit('error',{ message: 'Socket join error'});
		}
	});

	socket.on("game:leave", async ({ gameId }) => {
		try
		{
			socket.leave(String(gameId));
			await disconnectPlayer(io, gameId, socket.user.id);
			console.log("PLAYER LEFT GAME", socket.user.id, gameId);
		}
		catch (err)
		{
			console.error("game:leave error", err);
		}
	});

	socket.on('game:state',
		async ({ gameId }) => {
			try
			{
				const game = await getGame(gameId);
				if (!game)
					return socket.emit('error', {message: 'Game not found'});

				io.to(String(gameId)
					).emit('game:update', await normalizeGame(game));
			}
			catch (err)
			{
				console.error('game:state error:', err);
			}
		}
	);

	socket.on('chat:send',
		async ({ gameId, message }) => {
			try
			{
				if (!message?.trim())
					return;

				const game = await getGame(gameId);
				if (!game)
					return;

				const player = game.players.find(p => p.id === socket.user.id);
				if (!player)
					return;

				io.to(String(gameId)).emit('chat:message',
					{
						userId: socket.user.id,
						color: player.color,
						message: message.trim(),
						timestamp: Date.now()
					}
				);
			}
			catch (err)
			{
				console.error('chat:send error', err);
			}
		}
	);

	socket.on("disconnect", async (reason) => {
		console.log(socket.rooms);
		console.log("SOCKET DISCONNECT", socket.user.id, reason);

		try
		{
			const joinedGames = Array
				.from(socket.rooms)
				.filter(room => room !== socket.id);

			for (const gameId of joinedGames)
			{
				await disconnectPlayer(io, gameId, socket.user.id);
			}
		}
		catch (err)
		{
			console.error(err);
		}
	});
}

module.exports = registerGameSocket;