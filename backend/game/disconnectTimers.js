const timers = new Map();

function getKey(gameId, userId)
{
	return `${gameId}:${userId}`;
}

function clearDisconnectTimer(gameId, userId)
{
	const key = getKey(gameId, userId);
	const timer = timers.get(key);
	if (timer)
	{
		clearTimeout(timer);
		timers.delete(key);
	}
}

function setDisconnectTimer(gameId, userId, timer)
{
	clearDisconnectTimer(gameId, userId);
	timers.set(getKey(gameId, userId), timer);
}

module.exports = {clearDisconnectTimer, setDisconnectTimer};