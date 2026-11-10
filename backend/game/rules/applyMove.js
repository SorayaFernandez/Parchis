const { MAIN_TRACK_SIZE, FINAL_POSITION } = require('../constants');
const isEnteringHomeStretch = require('../utils/isEnteringHomeStretch');
const getDistanceToHomeEntry = require('../utils/getDistanceToHomeEntry');

function applyMove(game, playerId, pieceIndex, steps = game.dice)
{
	const player = game.players.find(p => p.id === playerId);

	if (!player)
		return null;

	const piece = player.pieces[pieceIndex];

	if (!piece)
		return null;

	let reachedGoal = false;

	if (!game.moveCounter)
		game.moveCounter = 0;

	if (piece.state === 'base' && steps === 5)
	{
		piece.state = 'track';
		piece.steps = 0;
		piece.arrivalOrder = ++game.moveCounter;

		return {
			piece,
			reachedGoal,
			leftBase: true
		};
	}

	if (piece.steps >= MAIN_TRACK_SIZE)
	{
		piece.steps += steps;
		piece.arrivalOrder = ++game.moveCounter;

		if (piece.steps === FINAL_POSITION)
		{
			piece.state = 'finished';
			reachedGoal = true;
		}

		return {
			piece,
			reachedGoal
		};
	}

	if (isEnteringHomeStretch(player.color, piece.steps, steps))
	{
		const distanceToEntry = getDistanceToHomeEntry(player.color, piece.steps);
		const overshoot = steps - distanceToEntry - 1;

		piece.steps = MAIN_TRACK_SIZE + overshoot;
		piece.state = 'final';
		piece.arrivalOrder = ++game.moveCounter;

		if (piece.steps === FINAL_POSITION)
		{
			piece.state = 'finished';
			reachedGoal = true;
		}

		return {
			piece,
			reachedGoal
		};
	}

	piece.steps += steps;
	piece.arrivalOrder = ++game.moveCounter;

	return {
		piece,
		reachedGoal
	};
}

module.exports = applyMove;