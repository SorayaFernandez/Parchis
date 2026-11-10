const pool = require('./db');

async function initDB()
{
	try
	{
		// USERS:
		await pool.query(`
			CREATE TABLE IF NOT EXISTS users (
			id SERIAL PRIMARY KEY,
			username VARCHAR(50) UNIQUE NOT NULL,
			email VARCHAR(255) UNIQUE NOT NULL,
			password TEXT NOT NULL,
			avatar_url TEXT DEFAULT '/uploads/default-avatar.png',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
		`);

		// FRIENDSHIPS:
		await pool.query(`
			CREATE TABLE IF NOT EXISTS friendships (
				id SERIAL PRIMARY KEY,
				requester_id INTEGER NOT NULL
					REFERENCES users(id)
					ON DELETE CASCADE,
				addressee_id INTEGER NOT NULL
					REFERENCES users(id)
					ON DELETE CASCADE,
				status VARCHAR(20)
					NOT NULL DEFAULT 'pending',
				created_at TIMESTAMP
					DEFAULT CURRENT_TIMESTAMP,
				accepted_at TIMESTAMP NULL,
				CHECK (requester_id <> addressee_id),
				UNIQUE (requester_id, addressee_id)
			);
		`);

		// GAMES: 
		await pool.query(`
			CREATE TABLE IF NOT EXISTS games (
			id VARCHAR(255) PRIMARY KEY,
			host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			state JSONB NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'waiting',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
		`);

		//lobby chat:
		await pool.query(`
			CREATE TABLE IF NOT EXISTS lobby_messages (
				id SERIAL PRIMARY KEY,
				user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
				message TEXT NOT NULL,
				expected_reads INTEGER NOT NULL DEFAULT 0,
				read_by INTEGER[] NOT NULL DEFAULT '{}',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

		//usuarios bloqueados en el chat:
		await pool.query(`
			CREATE TABLE IF NOT EXISTS blocked_users (
			id SERIAL PRIMARY KEY,
			blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
			blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
			UNIQUE(blocker_id, blocked_id)
			)
		`);
		console.log('✅ Tablas listas');
	}
	catch (err)
	{
		console.error('❌ Error creando tablas:', err);
		throw err;
	}
}

module.exports = initDB;