const getBlockades = require('./getBlockades');

function isDestinationBlocked(game, globalPosition)
{
	const blockades = getBlockades(game);
	return blockades.some(blockade => blockade.position === globalPosition);
}

module.exports = isDestinationBlocked;