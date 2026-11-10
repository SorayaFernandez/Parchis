const {START_POSITIONS, MAIN_TRACK_SIZE} = require('../constants');

function getRealBoardPosition(color, steps)
{
	if (steps < 0)
		return -1;
	return (START_POSITIONS[color] + steps) % MAIN_TRACK_SIZE;
}

module.exports = getRealBoardPosition;