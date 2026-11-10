function isGameAbandoned(game)
{
    return game.players.every(player => player.abandoned);
}

module.exports = isGameAbandoned;