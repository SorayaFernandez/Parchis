const { TURN_ORDER } = require('../constants');

function nextTurn(game)
{
	const currentPlayer = game.players.find(player => player.id === game.turn);
	let colorIndex = TURN_ORDER.indexOf(currentPlayer.color);
	let nextPlayer;

	do
	{
		colorIndex = (colorIndex + 1) % TURN_ORDER.length;
		nextPlayer = game.players.find(player => player.color === TURN_ORDER[colorIndex]);
	}
	while (
		!nextPlayer
		|| game.finishedPlayers.includes(nextPlayer.id)
	);

	game.turn = nextPlayer.id;
}

module.exports = nextTurn;