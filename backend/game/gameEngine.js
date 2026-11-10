const { COLORS, GAME_STATUS, CAPTURE_BONUS, GOAL_BONUS } = require('./constants');
const canMovePiece = require('./validators/canMovePiece');
const applyMove = require('./rules/applyMove');
const nextTurn = require('./rules/nextTurn');
const checkCapture = require('./rules/checkCapture');
const checkWin = require('./rules/checkWin');
const createPieces = require('./utils/createPieces');
const getAvailableMoves = require('./rules/getAvailableMoves');
const { startTurnTimer, clearTurnTimer } = require('./turnTimer');

function rollDice()
{
	return Math.floor(Math.random() * 6) + 1;
}

function addPlayerToGame(game, userId)
{
	if (game.players.length >= 4)
	{
		return {
			error: 'Game full'
		};
	}
	const alreadyInGame = game.players.find(player => player.id === userId);
	if (alreadyInGame)
	{
		return {
			error: 'Already in game'
		};
	}
	const color = COLORS[game.players.length];
	game.players.push({
		id: userId,
		color,
		connected: true,
		disconnectedAt: null,
		abandoned: false,
		pieces: createPieces()
	});
	game.updatedAt = Date.now();
	return {
		ok: true
	};
}

function sendLastMovedPieceToBase(game)
{
	const info = game.lastMovedPiece;
	if (!info)
	{
		return;
	}
	const player = game.players.find(p => p.id === info.playerId);
	if (!player)
	{
		return;
	}
	const piece = player.pieces[info.pieceIndex];
	if (!piece)
	{
		return;
	}
	piece.steps = -1;
	piece.state = 'base';
}

function executeMove(game, playerId, pieceIndex)
{
	if (!game || !Array.isArray(game.players)) {
		return { error: "Invalid game state (players missing)" };
	}

	if (game.pendingBonus)
	{
		return {
			ok: false,
			error: "Bonus move pending"
		};
	}

	const validation = canMovePiece(game, playerId, pieceIndex);
	if (!validation.ok)
		return validation;
	const moveResult = applyMove(game, playerId, pieceIndex);
	game.lastMovedPiece = { playerId, pieceIndex};

	const captured = checkCapture(
		game,
		playerId,
		moveResult.piece,
		moveResult.leftBase
	);
	const reachedGoal = moveResult.reachedGoal;

	const player = game.players.find(p => p.id === playerId);

	if (!player) {
		return { error: "Player not found" };
	}

	const won = checkWin(game, playerId);

	if (won)
	{
		if (!game.finishedPlayers)
			game.finishedPlayers = [];

		if (!game.ranking)
			game.ranking = [];

		if (!game.finishedPlayers.includes(playerId))
		{
			game.finishedPlayers.push(playerId);
			game.ranking.push(playerId);
		}

		const activePlayers = game.players.length - (game.finishedPlayers?.length || 0);
		if (activePlayers === 1)
		{
			const lastPlayer = game.players.find(p => !game.finishedPlayers.includes(p.id));
			if (lastPlayer)
			{
				game.finishedPlayers.push(lastPlayer.id);
				game.ranking.push(lastPlayer.id);
			}
			clearTurnTimer(game.id);
			game.status = GAME_STATUS.FINISHED;
			game.winner = game.ranking[0];
			return {
				ok: true,
				finished: true
			};
		}
		nextTurn(game);
		return {
			ok: true,
			playerFinished: true,
			finished: false
		};
	}

	if (captured)
	{
		const hasMoves = getAvailableMoves(game, playerId, CAPTURE_BONUS).length > 0;
		if (hasMoves)
		{
			game.pendingBonus = CAPTURE_BONUS;
			game.pendingBonusPlayer = playerId;
			game.pendingBonusFromSix = (game.dice === 6);

			game.dice = null;
			game.updatedAt = Date.now();

			return {
				ok: true,
				pendingBonus: true,
				bonus: CAPTURE_BONUS
			};
		}
	}

	if (reachedGoal)
	{
		const hasMoves = getAvailableMoves(game, playerId, GOAL_BONUS).length > 0;
		if (hasMoves)
		{
			game.pendingBonus = GOAL_BONUS;
			game.pendingBonusPlayer = playerId;
			game.pendingBonusFromSix = (game.dice === 6);

			game.dice = null;
			game.updatedAt = Date.now();

			return {
				ok: true,
				pendingBonus: true,
				bonus: GOAL_BONUS
			};
		}
	}

	if (!game.consecutiveSixes)
		game.consecutiveSixes = {};
	if (!game.consecutiveSixes[playerId])
		game.consecutiveSixes[playerId] = 0;
	if (game.dice === 6)
	{
		game.consecutiveSixes[playerId]++;
		if (game.consecutiveSixes[playerId] >= 3)
		{
			sendLastMovedPieceToBase(game);
			game.consecutiveSixes[playerId] = 0;
			game.lastMovedPiece = null;
			nextTurn(game);
			game.dice = null;
			game.updatedAt = Date.now();
			startTurnTimer(game.id);
			return {
				ok: true,
				thirdSixPenalty: true
			};
		}
	}
	else
	{
		game.consecutiveSixes[playerId] = 0;
		nextTurn(game);
	}
	game.dice = null;
	game.updatedAt = Date.now();
	startTurnTimer(game.id);
	return { ok: true };
}

function executeBonusMove(
	game,
	playerId,
	pieceIndex
)
{
	if (
		game.pendingBonusPlayer !== playerId
	)
	{
		return {
			ok:false,
			error:'No pending bonus'
		};
	}

	const validation =
		canMovePiece(
			game,
			playerId,
			pieceIndex,
			game.pendingBonus
		);

	if (!validation.ok)
		return validation;

	const moveResult =
		applyMove(
			game,
			playerId,
			pieceIndex,
			game.pendingBonus
		);

	game.lastMovedPiece = {
		playerId,
		pieceIndex
	};

	const captured = checkCapture(
		game,
		playerId,
		moveResult.piece,
		moveResult.leftBase
	);

	const reachedGoal =
		moveResult.reachedGoal;

	const won =
		checkWin(game,playerId);

	if (won)
	{
		if (!game.finishedPlayers)
			game.finishedPlayers = [];

		if (!game.ranking)
			game.ranking = [];

		if (!game.finishedPlayers.includes(playerId))
		{
			game.finishedPlayers.push(playerId);
			game.ranking.push(playerId);
		}

		const activePlayers = game.players.length - (game.finishedPlayers?.length || 0);
		if (activePlayers === 1)
		{
			const lastPlayer = game.players.find(p => !game.finishedPlayers.includes(p.id));
			if (lastPlayer)
			{
				game.finishedPlayers.push(lastPlayer.id);
				game.ranking.push(lastPlayer.id);
			}
			game.pendingBonus = null;
			game.pendingBonusPlayer = null;
			game.pendingBonusFromSix = false;
			clearTurnTimer(game.id);
			game.status = GAME_STATUS.FINISHED;
			game.winner = game.ranking[0];
			return {
				ok: true,
				finished: true
			};
		}

		if (captured)
		{
			const hasMoves = getAvailableMoves(game, playerId, CAPTURE_BONUS).length > 0;
			if (hasMoves)
			{
				game.pendingBonus = CAPTURE_BONUS;
				game.pendingBonusPlayer = playerId;

				game.updatedAt = Date.now();

				return {
					ok: true,
					pendingBonus: true
				};
			}
		}

		if (reachedGoal)
		{
			const hasMoves = getAvailableMoves(game, playerId, GOAL_BONUS).length > 0;
			if (hasMoves)
			{
				game.pendingBonus = GOAL_BONUS;
				game.pendingBonusPlayer = playerId;

				game.updatedAt = Date.now();

				return {
					ok: true,
					pendingBonus: true
				};
			}
		}

		const extraRoll = game.pendingBonusFromSix;
		game.pendingBonus = null;
		game.pendingBonusPlayer = null;
		game.pendingBonusFromSix = false;
		if (extraRoll)
		{
			game.dice = null;
			startTurnTimer(game.id);
			return {
				ok: true,
				playerFinished: true,
				finished: false,
				extraRoll: true
			};
		}
		nextTurn(game);
		return {
			ok: true,
			playerFinished: true,
			finished: false
		};
	}

	const extraRoll = game.pendingBonusFromSix;
	game.pendingBonus = null;
	game.pendingBonusPlayer = null;
	game.pendingBonusFromSix = false;
	if (extraRoll)
	{
		game.dice = null;
		game.updatedAt = Date.now();
		startTurnTimer(game.id);
		return {
			ok: true,
			extraRoll: true
		};
	}
	nextTurn(game);
	game.updatedAt = Date.now();
	startTurnTimer(game.id);
	return {
		ok: true
	};
}

module.exports = { rollDice, addPlayerToGame, executeMove, executeBonusMove };