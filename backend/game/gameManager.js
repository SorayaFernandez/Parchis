const pool = require('../db');

// CREATE GAME:
async function createGame(game, hostId)
{
	try
	{
		await pool.query(
			`
			INSERT INTO games (id, host_id, state, status)
			VALUES ($1, $2, $3, $4)
			`,
			[
				game.id,
				hostId,
				JSON.stringify(game),
				game.status
			]
		);

		return true;
	}
	catch (err)
	{
		console.error('createGame error:', err);
		return false;
	}
}

// GET GAME:
async function getGame(gameId) {
  const result = await pool.query(
    `SELECT state FROM games WHERE id = $1`,
    [gameId]
  );

  if (result.rows.length === 0) return null;

  const state = result.rows[0].state;

  if (typeof state === 'string') {
    try {
      return JSON.parse(state);
    } catch (e) {
      console.error('Corrupted game state', e);
      return null;
    }
  }

  return state;
}

// SAVE GAME:
async function saveGame(game)
{
	try
	{
		await pool.query(
			`
			UPDATE games
			SET state = $1,
				status = $2,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = $3
			`,
			[
				JSON.stringify(game),
				game.status,
				game.id
			]
		);
		return true;
	}
	catch (err)
	{
		console.error('saveGame error:', err);
		return false;
	}
}

// DELETE GAME:
async function deleteGame(gameId)
{
	try
	{
		console.log("DELETING GAME", gameId);
		await pool.query(
			`
			DELETE FROM games
			WHERE id = $1
			RETURNING id
			`,
			[gameId]
		);
		console.log("DELETE RESULT:", result.rowCount, result.rows);
		return true;
	}
	catch (err)
	{
		console.error('deleteGame error:', err);
		return false;
	}
}

async function getGameByPlayer(userId)
{
	const result = await pool.query(
		`
		SELECT state
		FROM games
		WHERE status <> 'finished'
		`
	);

	for (const row of result.rows)
	{
		const game =
			typeof row.state === "string"
				? JSON.parse(row.state)
				: row.state;
		
		console.log("CHECK GAME", game.id, game.status);

		const player = game.players.find(p => p.id === userId);

		console.log(player);

		if (!player)
			continue;

		if (player.abandoned)
			continue;

		return game;
	}

	return null;
}

module.exports = {createGame, getGame, saveGame, deleteGame, getGameByPlayer};