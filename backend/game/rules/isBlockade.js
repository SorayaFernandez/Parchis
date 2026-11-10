const {MAIN_TRACK_SIZE} = require('../constants');
const getRealBoardPosition = require('../utils/getRealBoardPosition');

function isBlockade(game, color, globalPosition)
{
	const player = game.players.find(p => p.color === color);
	if (!player)
		return false;

	let count = 0;

	for (const piece of player.pieces)
	{
		if (piece.steps < 0)
			continue;
		if (piece.steps >= MAIN_TRACK_SIZE)
			continue;

		const position = getRealBoardPosition(color, piece.steps);
		if (position === globalPosition)
			count++;
	}

	return count >= 2;
}

module.exports = isBlockade;