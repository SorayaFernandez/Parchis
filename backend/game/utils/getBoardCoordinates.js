const BOARD_MAP = require("./boardMap");

function getBoardCoordinates(position)
{
	if (position < 0 || position >= BOARD_MAP.length)
		return null;
	return BOARD_MAP[position];
}

module.exports = getBoardCoordinates;