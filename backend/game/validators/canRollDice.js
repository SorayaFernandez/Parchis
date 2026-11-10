const { GAME_STATUS } = require('../constants');

function canRollDice(game, userId)
{
	if (game.status === GAME_STATUS.WAITING)
	{
		if (game.players.length < 2)
		{
			return {
				ok: false,
				error: 'Waiting for another player'
			};
		}

		if (game.players[0].id !== userId)
		{
			return {
				ok: false,
				error: 'Only host can start game'
			};
		}

		return {
			ok: true,
			startGame: true
		};
	}

	if (game.status !== GAME_STATUS.PLAYING)
	{
		return {
			ok: false,
			error: 'Game is not active'
		};
	}

	if (game.finishedPlayers && game.finishedPlayers.includes(userId))
	{
	    return {
	        ok: false,
	        error: 'You have already finished'
	    };
	}

	if (game.turn !== userId)
	{
		return {
			ok: false,
			error: 'Not your turn'
		};
	}

	if (game.dice !== null)
	{
		return {
			ok: false,
			error: 'Dice already rolled'
		};
	}

	if (
		game.pendingBonus &&
		game.pendingBonusPlayer === userId
	)
	{
		return {
			ok: false,
			error: 'You must play the bonus first'
		};
	}

	return { ok: true };
}

module.exports = canRollDice;