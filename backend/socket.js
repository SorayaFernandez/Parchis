let io = null;

// SET IO INSTANCE:
function setIO(serverIO)
{
	io = serverIO;
}

// GET IO INSTANCE:
function getIO()
{
	if (!io)
		throw new Error("Socket.io not initialized");
	return io;
}

module.exports = {setIO, getIO};