const canMovePiece = require('../validators/canMovePiece');
const getBlockades = require('./getBlockades');
const getRealBoardPosition = require('../utils/getRealBoardPosition');
const { MAIN_TRACK_SIZE } = require('../constants');

function getAvailableMoves(game, playerId, steps = game.dice)
{
	const moves = [];
	for (let i = 0; i < 4; i++)
	{
		const validation = canMovePiece(game, playerId, i, steps);

		if (validation.ok)
			moves.push(i);
	}

	if (steps !== 6)
		return moves;

	const player = game.players.find(p => p.id === playerId);
	if (!player)
		return moves;

	const blockade = getBlockades(game).find(b => b.color === player.color);
	if (!blockade)
		return moves;

	const blockadePieces = [];
	player.pieces.forEach((piece, index) =>
	{
		if (piece.steps < 0)
			return;
		if (piece.steps >= MAIN_TRACK_SIZE)
			return;
		const position = getRealBoardPosition(player.color, piece.steps);
		if (position === blockade.position)
			blockadePieces.push(index);
	});
	const forcedMoves = moves.filter(index => blockadePieces.includes(index));
	return forcedMoves;
}

module.exports = getAvailableMoves;