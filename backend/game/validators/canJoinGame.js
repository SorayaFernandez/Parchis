const { GAME_STATUS } = require('../constants');

function canJoinGame(game, userId)
{
	const alreadyInGame = game.players.find(player => player.id === userId);

	if (alreadyInGame)
	{
		return {
			ok: true,
			rejoin: true
		};
	}

	if (game.status === GAME_STATUS.FINISHED)
	{
		return {
			ok: false,
			error: 'Game finished'
		};
	}

	if (game.status === GAME_STATUS.WAITING)
	{
		if (game.players.length < 4)
		{
			return {
				ok: true,
				asSpectator: false
			};
		}

		return {
			ok: true,
			asSpectator: true
		};
	}

	if (
		game.status === GAME_STATUS.PLAYING ||
		game.status === GAME_STATUS.PAUSED
	)
	{
		return {
			ok: true,
			asSpectator: true
		};
	}

	return { ok: false };
}

module.exports = canJoinGame;