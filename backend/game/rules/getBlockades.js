const {MAIN_TRACK_SIZE} = require('../constants');
const getRealBoardPosition = require('../utils/getRealBoardPosition');

function getBlockades(game)
{
	const blockades = [];
	for (const player of game.players)
	{
		const count = {};
		for (const piece of player.pieces)
		{
			if (piece.steps < 0)
				continue;

			if (piece.steps >= MAIN_TRACK_SIZE)
				continue;
			const position = getRealBoardPosition(player.color, piece.steps);
			count[position] = (count[position] || 0) + 1;
		}
		for (const position in count)
		{
			if (count[position] >= 2)
			{
				blockades.push({
					color: player.color,
					position: Number(position)
				});
			}
		}
	}
	return blockades;
}

module.exports = getBlockades;