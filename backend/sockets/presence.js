const onlineUsers = new Map();

function addUserSocket(userId, socketId)
{
	if (!onlineUsers.has(userId))
		onlineUsers.set(userId, new Set());
	onlineUsers.get(userId).add(socketId);
}

function removeUserSocket(userId, socketId)
{
	if (!onlineUsers.has(userId))
		return;

	const sockets = onlineUsers.get(userId);
	sockets.delete(socketId);
	if (sockets.size === 0)
		onlineUsers.delete(userId);
}

function isUserOnline(userId)
{
	return onlineUsers.has(userId);
}

function getOnlineUsers()
{
	return Array.from(onlineUsers.keys());
}

function getUserSockets(userId)
{
	return onlineUsers.get(userId) || new Set();
}

module.exports = {addUserSocket, removeUserSocket, isUserOnline, getOnlineUsers, getUserSockets};