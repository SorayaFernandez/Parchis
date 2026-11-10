const pool = require('../db');
const { isUserOnline } = require('../sockets/presence');
const {validateId} = require('../utils/validation');

exports.sendRequest = async (req, res) => {
	try
	{
		const requesterId = req.user.id;
		const idValidation = validateId(req.params.id);
		if (!idValidation.ok)
			return res.status(400).json({
				error: idValidation.error
			});

		const addresseeId = idValidation.value;
		if (requesterId === addresseeId)
			return res.status(400).json({
				error: 'No puedes agregarte'
			});

		const existing = await pool.query(
			`
			SELECT *
			FROM friendships
			WHERE
				(requester_id = $1 AND addressee_id = $2)
				OR
				(requester_id = $2 AND addressee_id = $1)
			`,
			[
				requesterId,
				addresseeId
			]
		);

		if (existing.rows.length > 0)
			return res.status(400).json({
				error: 'La relación ya existe'
			});

		const result = await pool.query(
			`
			INSERT INTO friendships (
				requester_id,
				addressee_id,
				status
			)
			VALUES ($1, $2, 'pending')
			RETURNING *
			`,
			[
				requesterId,
				addresseeId
			]
		);

		return res.status(201).json({
			success: true,
			request: result.rows[0]
		});
	}
	catch (error)
	{
		console.error(error);

		return res.status(500).json({
			error: 'Error en el servidor'
		});
	}
};

exports.acceptRequest = async (req, res) => {
	try
	{
		const userId = req.user.id;

		const idValidation = validateId(req.params.id);

		if (!idValidation.ok)
			return res.status(400).json({
				error: idValidation.error
			});

		const requesterId = idValidation.value;

		const result = await pool.query(
			`
			UPDATE friendships
			SET
				status = 'accepted',
				accepted_at = CURRENT_TIMESTAMP
			WHERE
				requester_id = $1
				AND addressee_id = $2
				AND status = 'pending'
			RETURNING *
			`,
			[
				requesterId,
				userId
			]
		);

		if (result.rows.length === 0)
			return res.status(404).json({
				error: 'Solicitud no encontrada'
			});

		return res.json({
			success: true,
			friendship: result.rows[0]
		});
	}
	catch (error)
	{
		console.error(error);

		return res.status(500).json({
			error: 'Error en el servidor'
		});
	}
};

exports.getFriends = async (req, res) => {
	try
	{
		const userId = req.user.id;
		const result = await pool.query(
			`
			SELECT
				u.id,
				u.username,
				u.avatar_url
			FROM friendships f
			JOIN users u
			ON (
				u.id =
				CASE
					WHEN f.requester_id = $1
					THEN f.addressee_id
					ELSE f.requester_id
				END
			)
			WHERE
				(f.requester_id = $1 OR f.addressee_id = $1)
				AND f.status = 'accepted'
			`,
			[userId]
		);

		const friends = result.rows.map(friend => ({
			...friend,
			online: isUserOnline(friend.id)
		}));

		return res.json({
			friends
		});
	}
	catch (error)
	{
		console.error(error);

		return res.status(500).json({
			error: 'Error en el servidor'
		});
	}
};

exports.getPendingRequests = async (req, res) => {
	try
	{
		const userId = req.user.id;
		const result = await pool.query(
			`
			SELECT
				f.requester_id as "senderId",
				u.username as "senderUsername",
				u.avatar_url,
				f.created_at
			FROM friendships f
			JOIN users u
			ON u.id = f.requester_id
			WHERE
				f.addressee_id = $1
				AND f.status = 'pending'
			`,
			[userId]
		);

		return res.json({
			requests: result.rows
		});
	}
	catch (error)
	{
		console.error(error);

		return res.status(500).json({
			error: 'Error en el servidor'
		});
	}
};

exports.removeFriend = async (req, res) => {
	try
	{
		const userId = req.user.id;

		const idValidation = validateId(req.params.id);

		if (!idValidation.ok)
			return res.status(400).json({
				error: idValidation.error
			});

		const friendId = idValidation.value;

		const result = await pool.query(
			`
			DELETE FROM friendships
			WHERE
				(
					requester_id = $1
					AND addressee_id = $2
				)
				OR
				(
					requester_id = $2
					AND addressee_id = $1
				)
			RETURNING *
			`,
			[
				userId,
				friendId
			]
		);

		if (result.rows.length === 0)
			return res.status(404).json({
				error: 'Amistad no encontrada'
			});

		return res.json({
			success: true
		});
	}
	catch (error)
	{
		console.error(error);
		return res.status(500).json({
			error: 'Error en el servidor'
		});
	}
};