const {START_POSITIONS, MAIN_TRACK_SIZE} = require('../constants');

function getGlobalPosition(color, relativePosition)
{
	return (START_POSITIONS[color] + relativePosition) % MAIN_TRACK_SIZE;
}

module.exports = getGlobalPosition;