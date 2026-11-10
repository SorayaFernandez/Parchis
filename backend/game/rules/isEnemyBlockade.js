const getBlockades = require('./getBlockades');

function isEnemyBlockade(game, playerColor, globalPosition)
{
	const blockades = getBlockades(game);
	return blockades.some(blockade => blockade.position === globalPosition && blockade.color !== playerColor);
}

module.exports = isEnemyBlockade;