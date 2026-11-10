const jwt = require('jsonwebtoken');

function authSocket(socket, next)
{
	try
	{
		const token = socket.handshake.auth?.token;
		if (!token)
			return next(new Error('Authentication error'));

		const decoded = jwt.verify( token, process.env.JWT_SECRET);

		socket.user = decoded;

		next();
	}
	catch (err)
	{
		console.error(err);
		next(new Error('Invalid token'));
	}
}

module.exports = authSocket;