const {HOME_ENTRIES, MAIN_TRACK_SIZE} = require('../constants');
const getRealBoardPosition = require('./getRealBoardPosition');

function getDistanceToHomeEntry(color, steps)
{
	const current = getRealBoardPosition(color, steps);
	const entry = HOME_ENTRIES[color] % MAIN_TRACK_SIZE;
	if (current <= entry)
		return entry - current;

	return (MAIN_TRACK_SIZE - current + entry);
}

module.exports = getDistanceToHomeEntry;