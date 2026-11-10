function validateTurn(game, userId)
{
	if (game.turn !== userId)
	{
		return{
			ok: false,
			error: "Not your turn"
		};
	}

	return { ok: true };
}

module.exports = validateTurn;