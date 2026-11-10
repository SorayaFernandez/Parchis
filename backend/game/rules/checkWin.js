const {FINAL_POSITION} = require('../constants');

function checkWin(game, playerId)
{
	if (!game || !Array.isArray(game.players))
		return false;

	const player = game.players.find(p => p.id === playerId);
	if (!player)
		return false;

	return player.pieces.every(piece => piece.steps === FINAL_POSITION);
}

module.exports = checkWin;