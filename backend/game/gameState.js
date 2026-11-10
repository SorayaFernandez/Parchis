const createPieces = require('./utils/createPieces');
const { GAME_STATUS } = require('./constants');

function createNewGame(hostId)
{
	return {
		id: Date.now().toString(),
		players: [
			{
				id: hostId,
				color: "pink",
				connected: true,
				disconnectedAt: null,
				abandoned: false,
				pieces: createPieces()
			}
		],
		spectators: [],
		turn: hostId,
		dice: null,
		lastDice: null,
		consecutiveSixes: {},
		lastMovedPiece: null,
		pendingBonus: null,
		pendingBonusPlayer: null,
		winner: null,
		finishedPlayers: [],
		ranking: [],
		status: GAME_STATUS.WAITING,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
}

module.exports = { createNewGame };