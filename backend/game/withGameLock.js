const pool = require('../db');

function safeParse(state)
{
	if (!state)
		return null;

	if (typeof state === 'object')
		return state;

	if (typeof state === 'string')
	{
		try
		{
			return JSON.parse(state);
		}
		catch (e)
		{
			console.error('❌ JSON parse error:', e);
			return null;
		}
	}
	return null;
}

async function withGameLock(gameId, callback)
{
	const client = await pool.connect();
	try
	{
		await client.query('BEGIN');
		const result = await client.query(
			`
			SELECT state
			FROM games
			WHERE id = $1
			FOR UPDATE
			`,
			[gameId]
		);

		if (result.rows.length === 0)
		{
			await client.query('ROLLBACK');
			return null;
		}

		const game = safeParse(result.rows[0].state);

		if (!game || !Array.isArray(game.players))
		{
			console.error('❌ Invalid game state:', game);
			await client.query('ROLLBACK');
			return null;
		}

		const callbackResult = await callback(game, client);

		if (callbackResult == null)
		{
			await client.query("ROLLBACK");
			return {
				game,
				result: {
					error: "Callback returned invalid result"
				}
			};
		}

		if (callbackResult.deleteGame)
		{
			await client.query(
				`
				DELETE FROM games
				WHERE id = $1
				`,
				[gameId]
			);

			await client.query("COMMIT");

			return null;
		}

		if (callbackResult.error)
		{
			await client.query('ROLLBACK');
			return { game, result: callbackResult };
		}

		await client.query(
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
		await client.query('COMMIT');
		return { game, result: callbackResult };
	}
	catch (error)
	{
		await client.query('ROLLBACK');
		console.error('withGameLock error:', error);
		throw error;
	}
	finally
	{
		client.release();
	}
}

module.exports = withGameLock;