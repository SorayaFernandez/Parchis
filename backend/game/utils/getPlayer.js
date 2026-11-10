function getPlayer(game, playerId)
{
	return game.players.find(p => p.id === playerId);
}

module.exports = getPlayer;