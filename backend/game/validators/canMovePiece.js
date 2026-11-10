const getPlayer = require('../utils/getPlayer');
const getPiece = require('../utils/getPiece');
const {FINAL_POSITION, MAIN_TRACK_SIZE, SAFE_CELLS} = require('../constants');
const isEnteringHomeStretch = require('../utils/isEnteringHomeStretch');
const getDistanceToHomeEntry = require('../utils/getDistanceToHomeEntry');
const getRealBoardPosition = require('../utils/getRealBoardPosition');
const isPositionBlocked = require('../rules/isPositionBlocked');
const isDestinationBlocked = require('../rules/isDestinationBlocked');

function countPiecesOnPosition(game, globalPosition)
{
    let count = 0;
    for (const player of game.players)
    {
        for (const piece of player.pieces)
        {
            if (piece.steps < 0)
                continue;
            if (piece.steps >= MAIN_TRACK_SIZE)
                continue;
            if (getRealBoardPosition(player.color, piece.steps) === globalPosition)
                count++;
        }
    }
    return count;
}

function checkBasicMove(game, playerId, pieceIndex, steps)
{
	if (game.turn !== playerId)
	{
		return {
			ok: false,
			error: 'Not your turn'
		};
	}
	const player = getPlayer(game, playerId);
	if (!player)
	{
		return {
			ok: false,
			error: 'Player not found'
		};
	}
	const piece = getPiece(player, pieceIndex);
	if (!piece)
	{
		return {
			ok: false,
			error: 'Piece not found'
		};
	}
	if (steps === null)
	{
		return {
			ok: false,
			error: 'Roll dice first'
		};
	}

	if (piece.state === 'base')
	{
		if (steps !== 5)
		{
			return {
				ok: false,
				error: 'Need 5 to leave base'
			};
		}
		const exitPosition = getRealBoardPosition(player.color, 0);

		const ownPiecesOnExit = player.pieces.filter(p => {
			if (p.steps < 0)
				return false;
			const pos = getRealBoardPosition(player.color, p.steps);
			return pos === exitPosition;
		});
		if (ownPiecesOnExit.length >= 2)
		{
			return {
				ok: false,
				error: 'Own blockade on exit'
			};
		}

		const totalOnExit = countPiecesOnPosition(game, exitPosition);
		const enemyPiecesOnExit = totalOnExit - ownPiecesOnExit.length;
		const remainingAfterCapture = ownPiecesOnExit.length + Math.max(enemyPiecesOnExit - 1, 0);
		if (remainingAfterCapture + 1 > 2)
		{
			return {
				ok: false,
				error: 'Casilla de salida llena (máx 2 fichas)'
			};
		}

		return { ok: true };
	}

	if (piece.state === 'finished')
	{
		return {
			ok: false,
			error: 'Piece already finished'
		};
	}

	if (piece.steps >= MAIN_TRACK_SIZE)
	{
		if (piece.steps + steps > FINAL_POSITION)
		{
			return {
				ok: false,
				error: 'Exact roll required'
			};
		}

		return { ok: true };
	}

	const startPosition = getRealBoardPosition(player.color, piece.steps);

	for (let step = 1; step <= steps; step++)
	{
		if (isEnteringHomeStretch(player.color, piece.steps, step))
			break;

		const futureSteps = piece.steps + step;
		const globalPosition = getRealBoardPosition(player.color, futureSteps);

		if (isPositionBlocked(game, globalPosition, startPosition))
		{
			return {
				ok: false,
				error: 'Blockade in path'
			};
		}
	}

	if (isEnteringHomeStretch(player.color, piece.steps, steps))
	{
		const distanceToEntry = getDistanceToHomeEntry(player.color, piece.steps);
		const overshoot = steps - distanceToEntry - 1;
		const target = MAIN_TRACK_SIZE + overshoot;

		if (target > FINAL_POSITION)
		{
			return {
				ok: false,
				error: 'Exact roll required'
			};
		}

		return { ok: true };
	}

	const targetSteps = piece.steps + steps;
	const targetPosition = getRealBoardPosition(player.color, targetSteps);

	if (isDestinationBlocked(game, targetPosition))
	{
		return {
			ok: false,
			error: 'Destination blocked by blockade'
		};
	}

	const totalPiecesOnTarget = countPiecesOnPosition(game, targetPosition);
	const maxOnTarget = SAFE_CELLS.includes(targetPosition) ? 2 : 4;
	if (totalPiecesOnTarget >= maxOnTarget)
	{
	    return {
	        ok: false,
	        error: SAFE_CELLS.includes(targetPosition)
	            ? 'Casilla segura llena (máx 2 fichas)'
	            : 'Cell is full (max 4 pieces)'
	    };
	}

	return { ok: true };
}

function canMovePiece(game, playerId, pieceIndex, steps = game.dice)
{
	return checkBasicMove(game, playerId, pieceIndex, steps);
}

module.exports = canMovePiece;