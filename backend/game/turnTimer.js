const {TURN_TIMEOUT, GAME_STATUS} = require('./constants');
const nextTurn = require('./rules/nextTurn');
const withGameLock = require('./withGameLock');
const { getIO } = require('../socket');
const normalizeGame = require('./utils/normalizeGame');

// ACTIVE TIMERS:
const turnTimers = new Map();

// CLEAR TURN TIMER:
function clearTurnTimer(gameId)
{
	const existingTimer = turnTimers.get(gameId);
	if (existingTimer)
	{
		clearTimeout(existingTimer);
		turnTimers.delete(gameId);
	}
}

// START TURN TIMER:
function startTurnTimer(gameId)
{
	clearTurnTimer(gameId);
	const timeout = setTimeout(async () => {
		try
		{
			const locked = await withGameLock(gameId,
				async (game) => {
					if (game.status !== GAME_STATUS.PLAYING)
						return { skip: true };
					game.dice = null;
					if (game.pendingBonus && game.pendingBonusPlayer === game.turn)
					{
						game.pendingBonus = null;
						game.pendingBonusPlayer = null;
						game.pendingBonusFromSix = false;
					}
					nextTurn(game);
					game.updatedAt = Date.now();
					return { ok: true };
				});

			if (!locked)
			{
				clearTurnTimer(gameId);
				return;
			}

			if (locked.result.skip)
			{
				return;
			}

			startTurnTimer(gameId);

			getIO()
				.to(gameId)
				.emit("game:turn_timeout",{ nextTurn: locked.game.turn });

			const normalized = await normalizeGame(locked.game);

			getIO()
				.to(gameId)
				.emit("game:update", normalized);
		}
		catch (err)
		{
			console.error(err);
		}
	}, TURN_TIMEOUT);

	turnTimers.set(gameId, timeout);
}

module.exports = {startTurnTimer, clearTurnTimer};