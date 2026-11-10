require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const initDB = require('./initDb');
const initSockets = require('./sockets');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const friendsRoutes = require('./routes/friendsRoutes');
const gameRoutes = require('./routes/gameRoutes');
const app = express();
const path = require("path");

app.use(cors({
	origin: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE'],
	credentials: true
}));

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.get('/', (req, res) => {res.json({ status: 'ok' });});
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/games', gameRoutes);

const httpServer = http.createServer(app);
const PORT = process.env.PORT;

initDB()
	.then(() => {

		initSockets(httpServer);

		httpServer.listen(PORT, () => {
			console.log(`Backend running on port ${PORT}`);
		});
	})
	.catch((err) => {
		console.error('DB init failed:', err);
		process.exit(1);
	});