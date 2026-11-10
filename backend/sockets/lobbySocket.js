const pool = require("../db");
const { getIO } = require("../socket");
const {getOnlineUsers, getUserSockets, isUserOnline} = require("./presence");
const {getGameByPlayer, createGame: createGameInDB} = require("../game/gameManager");
const {createInvitation, getInvitation, deleteInvitation, removeInvitationsByUser} = require("./invitations");
const crypto = require("crypto");
const { createNewGame } = require("../game/gameState");
const { addPlayerToGame } = require("../game/gameEngine");
const normalizeGame = require("../game/utils/normalizeGame");

function sendLobbySystemMessage(message) {
	getIO().emit("lobby:system", {
		id: Date.now(),
		message,
		created_at: new Date().toISOString()
	});
}

function registerLobbySocket(io, socket) {
	socket.on('lobby:getHistory', async () => {
		try {
			const result = await pool.query(`
				SELECT
					m.id,
					m.message,
					m.created_at,
					m.expected_reads,
					m.read_by,
					u.id as user_id,
					u.username,
					u.avatar_url
				FROM lobby_messages m
				JOIN users u ON u.id = m.user_id
				WHERE u.id NOT IN (
					SELECT blocked_id
					FROM blocked_users
					WHERE blocker_id = $1
				)
				ORDER BY m.created_at ASC
				LIMIT 50
			`, [socket.user.id]);

			const messages = result.rows.map(row => ({
				id: row.id,
				message: row.message,
				created_at: row.created_at,
				expected_reads: row.expected_reads,
				read_by: row.read_by,
				user: {
					id: row.user_id,
					username: row.username,
					avatar_url: row.avatar_url
				}
			}));

			socket.emit('lobby:history', messages);
		} catch (err) {
			console.error('LOBBY HISTORY ERROR:', err);
		}
	});

	socket.on('lobby:send', async ({ message }) => {
		try {
			if (!message || !message.trim())
				return;
			
			const expectedReads = Math.max(getOnlineUsers().length, 1);
			const insertResult = await pool.query(
				`
				INSERT INTO lobby_messages
				(
					user_id,
					message,
					expected_reads,
					read_by
				)
				VALUES
				(
					$1,
					$2,
					$3,
					ARRAY[$1]::INTEGER[]
				)
				RETURNING *
				`,
				[socket.user.id, message.trim(), expectedReads]
			);

			const userResult = await pool.query(
				`
				SELECT id, username, avatar_url
				FROM users
				WHERE id = $1
				`,
				[socket.user.id]
			);

			io.emit("lobby:message", {
				id: insertResult.rows[0].id,
				message: insertResult.rows[0].message,
				created_at: insertResult.rows[0].created_at,

				expected_reads: insertResult.rows[0].expected_reads,
				read_by: insertResult.rows[0].read_by,

				user: userResult.rows[0],
			});
		}
		catch (err)
		{
			console.error('LOBBY SEND ERROR:', err);
		}
	});

	socket.on("lobby:read", async ({ messageId }) => {
		try {
			const result = await pool.query(
				`
				UPDATE lobby_messages
				SET read_by = array_append(read_by, $2)
				WHERE
					id = $1
					AND NOT ($2 = ANY(read_by))
				RETURNING id, expected_reads, read_by
				`,
				[
					messageId,
					socket.user.id,
				]
			);

			if (result.rows.length === 0)
				return;

			io.emit("lobby:readUpdate", {
				id: result.rows[0].id,
				expected_reads: result.rows[0].expected_reads,
				read_by: result.rows[0].read_by,
			});
		}
		catch (err) {
			console.error("READ RECEIPT ERROR:", err);
		}
	});

	socket.on('lobby:blockUser', async ({ blockedUserId }) => {
		try {
			if (!blockedUserId) return;
			if (blockedUserId === socket.user.id) return;

			await pool.query(
				`
				INSERT INTO blocked_users (blocker_id, blocked_id)
				VALUES ($1, $2)
				ON CONFLICT (blocker_id, blocked_id) DO NOTHING
				`,
				[socket.user.id, blockedUserId]
			);

			socket.emit('lobby:userBlocked', { blockedUserId });
		} catch (err) {
			console.error('BLOCK USER ERROR:', err);
		}
	});

	socket.on("lobby:invite", async ({ targetUserId }) => {
		try
		{
			if (!targetUserId)
				return;

			if (targetUserId === socket.user.id)
				return;

			const senderGame = await getGameByPlayer(socket.user.id);

			if (senderGame)
			{
				socket.emit("invite:error", {
					message: "You are already in a game."
				});
				return;
			}

			const targetGame = await getGameByPlayer(targetUserId);

			if (targetGame)
			{
				socket.emit("invite:error", {
					message: "That player is already in a game."
				});
				return;
			}

			if (!isUserOnline(targetUserId))
			{
				socket.emit("invite:error", {
					message: "That player is offline."
				});
				return;
			}

			const invite = {
				id: crypto.randomUUID(),
				from: socket.user.id,
				fromUsername: socket.user.username,
				to: targetUserId,
				createdAt: Date.now()
			};

			createInvitation(invite);

			const sockets = getUserSockets(targetUserId);

			for (const socketId of sockets)
			{
				io.to(socketId).emit("invite:received", invite);
			}

			socket.emit("invite:sent", {
				inviteId: invite.id
			});
		}
		catch (err)
		{
			console.error(err);
		}
	});

	socket.on("invite:accept", async ({ inviteId }) => {
		try
		{
			const invite = getInvitation(inviteId);
			if (!invite)
			{
				socket.emit("invite:expired");
				return;
			}

			if (invite.to !== socket.user.id)
				return;

			const senderGame = await getGameByPlayer(invite.from);
			const receiverGame = await getGameByPlayer(invite.to);
			if (senderGame || receiverGame)
			{
				deleteInvitation(invite.id);
				socket.emit("invite:expired");
				return;
			}

			const game = createNewGame(invite.from);
			addPlayerToGame(game, invite.to);
			await createGameInDB(game, invite.from);
	
			removeInvitationsByUser(invite.from);
			removeInvitationsByUser(invite.to);
	
			const senderSockets = getUserSockets(invite.from);
			for (const socketId of senderSockets)
			{
				io.to(socketId).emit("game:start", {
					gameId: game.id,
				});
			}
	
			const receiverSockets = getUserSockets(invite.to);
			for (const socketId of receiverSockets)
			{
				io.to(socketId).emit("game:start", {
					gameId: game.id,
				});
			}
		}
		catch (err)
		{
			console.error("invite:accept error:", err);
		}
	});

	socket.on("invite:reject", ({ inviteId }) => {
		try
		{
			const invite = getInvitation(inviteId);
			if (!invite)
				return;

			if (invite.to !== socket.user.id)
				return;
			deleteInvitation(inviteId);
			const senderSockets = getUserSockets(invite.from);
			for (const socketId of senderSockets)
			{
				io.to(socketId).emit("invite:rejected", {
					fromUserId: invite.to,
				});
			}
		}
		catch (err)
		{
			console.error("invite:reject error:", err);
		}
	});

	socket.on('lobby:typing', () => {
		socket.broadcast.emit('lobby:typing', {
			userId: socket.user.id
		});
	});
}

module.exports = {
	registerLobbySocket,
	sendLobbySystemMessage
};