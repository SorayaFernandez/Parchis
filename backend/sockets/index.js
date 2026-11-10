const { Server } = require('socket.io');
const authSocket = require('./authSocket');
const registerGameSocket = require('./gameSocket');
const { registerLobbySocket } = require("./lobbySocket");

const { setIO } = require('../socket');
const {
	addUserSocket,
	removeUserSocket,
	isUserOnline
} = require('./presence');

function initSockets(httpServer) {
	const io = new Server(httpServer, {
		cors: {
			origin: true,
			methods: ['GET', 'POST'],
			credentials: true
		}
	});

	setIO(io);

	io.use(authSocket);

	io.on('connection', (socket) => {
		const userId = socket.user.id;

		addUserSocket(userId, socket.id);

		io.emit('presence:update', {
			userId,
			online: true
		});

		registerGameSocket(io, socket);
		registerLobbySocket(io, socket);

		socket.on('disconnect', () => {
			removeUserSocket(userId, socket.id);

			if (!isUserOnline(userId)) {
				io.emit('presence:update', {
					userId,
					online: false
				});
			}
		});
	});
}

module.exports = initSockets;