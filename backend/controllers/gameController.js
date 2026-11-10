const getAvailableMoves = require('../game/rules/getAvailableMoves');
const nextTurn = require('../game/rules/nextTurn');
const { createNewGame } = require('../game/gameState');
const { rollDice, addPlayerToGame, executeMove, executeBonusMove} = require('../game/gameEngine');
const canJoinGame = require('../game/validators/canJoinGame');
const canRollDice = require('../game/validators/canRollDice');
const { getGame: getGameById, createGame: createGameInDB, getGameByPlayer } = require('../game/gameManager');
const withGameLock = require('../game/withGameLock');
const { getIO } = require('../socket');
const normalizeGame = require('../game/utils/normalizeGame');
const { startTurnTimer } = require('../game/turnTimer');
const { sendLobbySystemMessage } = require("../sockets/lobbySocket");
const pool = require("../db");
const {validateId, validatePieceIndex} = require("../utils/validation");

// CREATE GAME:
exports.createGame = async (req, res) => {
	try {
		const userId = Number(req.user.id);
		if (!userId)
			return res.status(401).json({ error: 'Invalid user' });

		const existing = await getGameByPlayer(userId);
		if (existing)
		{
			return res.json({
				reconnect: false,
				message: "You still have an active game. Wait until it expires."
			});
		}
		const game = createNewGame(userId);

		const created = await createGameInDB(game, userId);
		if (!created)
			return res.status(500).json({ error: 'Database error creating game' });

		const normalized = await normalizeGame(game);
		try {
			getIO().emit('game:created', normalized);
		} catch (socketError) {
			console.error('SOCKET ERROR:', socketError);
		}

		const userResult = await pool.query(
			"SELECT username FROM users WHERE id = $1",
			[userId]
		);

		sendLobbySystemMessage(`🎮 ${userResult.rows[0].username} has created a new game (ID: ${normalized.id})`);

		return res.status(201).json({
			id: normalized.id,
			game: normalized
		});
	} catch (error) {
		console.error('CREATE GAME ERROR:', error);
		return res.status(500).json({
			error: 'Server error creating game',
			details: error.message
		});
	}
};

// GET GAME:
exports.getGame = async (req, res) => {
	try {
		const gameIdValidation = validateId(req.params.id);
		if (!gameIdValidation.ok)
		{
			return res.status(400).json({
				error: gameIdValidation.error
			});
		}
		const game = await getGameById(gameIdValidation.value);
		if (!game)
			return res.status(404).json({ error: 'Game not found' });

		return res.json(await normalizeGame(game));
	} catch (error) {
		console.error(error);
		return res.status(500).json({ error: 'Server error' });
	}
};

// JOIN GAME:
exports.joinGame = async (req, res) => {
	try {
		const userId = Number(req.user.id);
		const gameIdValidation = validateId(req.params.id);
		if (!gameIdValidation.ok)
		{
			return res.json({
				success: false,
				error: gameIdValidation.error
			});
		}
		const gameId = String(gameIdValidation.value);
		const existing = await getGameByPlayer(userId);
		if (existing && existing.id !== gameId)
		{
			return res.json({
				reconnect: false,
				message: "You still have an active game. Wait until it expires."
			});
		}
		const locked = await withGameLock(gameId, async (game) => {
			if (!game)
				return { error: 'Game not found' };
			const validation = canJoinGame(game, userId);
			if (!validation.ok)
				return { error: validation.error };
			if (validation.rejoin)
			{
				const player = game.players.find(p => p.id === userId);
				if (player)
				{
					player.connected = true;
					player.abandoned = false;
					player.disconnectedAt = null;
				}
			}
			else
			{
				if (validation.asSpectator)
				{
					if (!game.spectators)
						game.spectators = [];
					if (!game.spectators.includes(userId))
						game.spectators.push(userId);
				}
				else
				{
					const addResult = addPlayerToGame(game, userId);
					if (addResult && addResult.error)
						return { error: addResult.error };
				}
			}
			game.updatedAt = Date.now();
			return { ok: true };
		});

		if (!locked)
		{
			return res.json({
				success: false,
				error: "Game not found"
			});
		}

		if (locked.result?.error)
			return res.json({success: false, error: locked.result.error});

		const normalized = await normalizeGame(locked.game);

		getIO().to(gameId).emit('game:update', normalized);

		return res.json(normalized);
	}
	catch (error)
	{
		console.error('JOIN GAME ERROR:', error);
		return res.status(500).json({
			error: 'Server error joining game',
			details: error.message
		});
	}
};

// ROLL DICE:
exports.rollDice = async (req, res) => {
	try {
		const userId = req.user.id;
		const gameIdValidation = validateId(req.params.id);
		if (!gameIdValidation.ok)
		{
			return res.status(400).json({
				error: gameIdValidation.error
			});
		}
		const gameId = String(gameIdValidation.value);
		const locked = await withGameLock(gameId, async (game) => {
			const isPlayer = game.players.some(p => p.id === userId);
			if (!isPlayer)
				return { error: 'Spectators cannot roll dice' };

			const validation = canRollDice(game, userId);
			if (!validation.ok)
				return { error: validation.error };

			if (validation.startGame) {
				game.status = 'playing';
				game.turn = game.players[0].id;
				startTurnTimer(game.id);
			}

			game.dice = rollDice();

			const availableMoves = getAvailableMoves(game, userId);

			if (availableMoves.length === 0) {
				game.lastDice = game.dice;

				if (game.dice === 6) {
					if (!game.consecutiveSixes)
						game.consecutiveSixes = {};
					if (!game.consecutiveSixes[userId])
						game.consecutiveSixes[userId] = 0;

					game.consecutiveSixes[userId]++;

					if (game.consecutiveSixes[userId] >= 3) {
						const info = game.lastMovedPiece;

						if (info) {
							const penaltyPlayer = game.players.find(p => p.id === info.playerId);

							if (penaltyPlayer) {
								const penaltyPiece = penaltyPlayer.pieces[info.pieceIndex];

								if (penaltyPiece) {
									penaltyPiece.steps = -1;
									penaltyPiece.state = 'base';
								}
							}
						}

						game.consecutiveSixes[userId] = 0;
						game.lastMovedPiece = null;
					}
				} else {
					if (!game.consecutiveSixes)
						game.consecutiveSixes = {};

					game.consecutiveSixes[userId] = 0;
					nextTurn(game);
				}

				setTimeout(async () => {
					try {
						await withGameLock(gameId, async (lockedGame) => {
							if (!lockedGame)
								return { error: 'Game not found' };

							lockedGame.dice = null;
							return { ok: true };
						});

						const refreshed = await getGameById(gameId);

						if (refreshed) {
							getIO()
								.to(gameId)
								.emit('game:update', await normalizeGame(refreshed));
						}
					} catch (err) {
						console.error(err);
					}
				}, 1500);
			}

			game.updatedAt = Date.now();

			return {
				ok: true,
				dice: game.dice
			};
		});

		if (!locked)
		{
			return res.json({
				success: false,
				error: "Game not found"
			});
		}

		if (locked.result?.error)
		{
			return res.json({success: false, error: locked.result.error});
		}

		const normalized = await normalizeGame(locked.game);

		getIO()
			.to(gameId)
			.emit('game:update', normalized);

		return res.json({success: true, dice: locked.result.dice});
	}
	catch (error)
	{
		console.error(error);
		return res.status(500).json({ error: 'Server error' });
	}
};

// MOVE PIECE:
exports.movePiece = async (req, res) => {
	try {
		const userId = req.user.id;
		const { pieceIndex } = req.body;
		const gameIdValidation = validateId(req.params.id);
		if (!gameIdValidation.ok)
		{
			return res.status(400).json({
				error: gameIdValidation.error
			});
		}
		const pieceValidation = validatePieceIndex(pieceIndex);
		if (!pieceValidation.ok)
		{
			return res.status(400).json({
				error: pieceValidation.error
			});
		}
		const gameId = String(gameIdValidation.value);
		const locked = await withGameLock(gameId, async (game) => {
			const isPlayer = game.players.some(p => p.id === userId);
			if (!isPlayer)
				return { error: 'Spectators cannot move pieces' };

			const result = executeMove(game, userId, pieceValidation.value);
			if (!result.ok)
				return result;

			game.updatedAt = Date.now();
			return result;
		});

		if (!locked)
		{
			return res.json({
				success: false,
				error: "Game not found"
			});
		}

		if (!locked.result?.ok)
			return res.status(400).json({ error: locked.result?.error || 'Move failed' });

		const normalized = await normalizeGame(locked.game);
		if (normalized.status === "finished")
		{
			sendLobbySystemMessage(`🏁 Game ${normalized.id} has finished.`);
		}

		getIO()
			.to(gameId)
			.emit('game:update', normalized);

		return res.json(normalized);
	} catch (error) {
		console.error(error);
		return res.status(500).json({ error: 'Server error' });
	}
};

exports.moveBonusPiece = async (req, res) => {
	try {
		const userId = req.user.id;
		const { pieceIndex } = req.body;
		const gameIdValidation = validateId(req.params.id);
		if (!gameIdValidation.ok)
		{
			return res.status(400).json({
				error: gameIdValidation.error
			});
		}
		const pieceValidation = validatePieceIndex(pieceIndex);
		if (!pieceValidation.ok)
		{
			return res.status(400).json({
				error: pieceValidation.error
			});
		}
		const gameId = String(gameIdValidation.value);
		const locked = await withGameLock(gameId, async (game) => {
			const isPlayer = game.players.some(
				p => p.id === userId
			);

			if (!isPlayer)
				return {
					error: "Spectators cannot move pieces"
				};


			const result = executeBonusMove(game, userId, pieceValidation.value);
			if (!result.ok)
				return result;

			game.updatedAt = Date.now();

			return result;
		});

		if (!locked)
		{
			return res.json({
				success: false,
				error: "Game not found"
			});
		}

		if (!locked.result.ok)
			return res.status(400).json({
				error:
					locked.result.error ||
					"Move failed"
			});

		const normalized =
			await normalizeGame(locked.game);

		getIO()
			.to(gameId)
			.emit("game:update", normalized);

		return res.json(normalized);
	}
	catch (error)
	{
		console.error(error);

		return res.status(500).json({
			error: "Server error"
		});
	}
};