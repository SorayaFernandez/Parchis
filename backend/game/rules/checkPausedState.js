const { GAME_STATUS } = require('../constants');
const { startTurnTimer, clearTurnTimer } = require('../turnTimer');

function checkPausedState(game)
{
	const disconnectedPlayers = game.players.filter(
		player => !player.connected && !player.abandoned
	);

	console.log('CHECK PAUSED', game.players.map(p => ({
		id: p.id,
		connected: p.connected,
		abandoned: p.abandoned
	})));

	if (game.status === GAME_STATUS.WAITING)
		return;

	if (disconnectedPlayers.length > 0)
	{
		game.status = GAME_STATUS.PAUSED;
		clearTurnTimer(game.id);
		return;
	}

	if (game.winner)
	{
		clearTurnTimer(game.id);
		return;
	}

	if (game.status === GAME_STATUS.PAUSED)
	{
		game.status = GAME_STATUS.PLAYING;
		startTurnTimer(game.id);
	}
}

module.exports = checkPausedState;