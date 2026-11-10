const {SAFE_CELLS, MAIN_TRACK_SIZE} = require('../constants');
const getRealBoardPosition = require('../utils/getRealBoardPosition');
const getBlockades = require('./getBlockades');

function checkCapture(game, currentPlayerId, movedPiece, justLeftBase = false)
{
	const currentPlayer = game.players.find(p => p.id === currentPlayerId);
	if (!currentPlayer)
		return false;
	if (!movedPiece)
		return false;
	if (movedPiece.steps < 0)
		return  false;
	if (movedPiece.steps >= MAIN_TRACK_SIZE)
		return false;
	const currentPosition = getRealBoardPosition(currentPlayer.color, movedPiece.steps);
	const isOwnExitOnLeaveBase = justLeftBase && movedPiece.steps === 0;
	if (SAFE_CELLS.includes(currentPosition) && !isOwnExitOnLeaveBase)
		return false;

	const blockades = getBlockades(game);

	const isBlockadeCell = blockades.some(blockade => blockade.position === currentPosition);
	if (isBlockadeCell && !isOwnExitOnLeaveBase)
		return false;

	const candidates = [];
	for (const enemy of game.players)
	{
		if (enemy.id === currentPlayerId)
			continue;

		for (const enemyPiece of enemy.pieces)
		{
			if (enemyPiece.steps < 0)
				continue;
			if (enemyPiece.steps >= MAIN_TRACK_SIZE)
				continue;
			const enemyPosition = getRealBoardPosition(enemy.color, enemyPiece.steps);
			if (enemyPosition !== currentPosition)
				continue;
			candidates.push(enemyPiece);
		}
	}

	if (candidates.length === 0)
		return false;

	let target = candidates[0];
	for (const candidate of candidates)
	{
		if ((candidate.arrivalOrder || 0) > (target.arrivalOrder || 0))
			target = candidate;
	}

	target.steps = -1;
	target.state = 'base';
	return true;
}

module.exports = checkCapture;