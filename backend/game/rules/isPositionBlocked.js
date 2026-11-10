const getBlockades = require('./getBlockades');

function isPositionBlocked(game, globalPosition, ignorePosition = null)
{
	const blockades = getBlockades(game);
	return blockades.some(blockade => {
		if (ignorePosition !== null && blockade.position === ignorePosition)
			return false;
		return blockade.position === globalPosition;
	});
}

module.exports = isPositionBlocked;