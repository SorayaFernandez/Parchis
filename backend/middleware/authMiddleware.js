const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
	const authHeader = req.headers.authorization;
	if (!authHeader)
		return res.status(401).json({ error: 'No token provided' });

	const [scheme, token] = authHeader.split(' ');
	if (scheme !== 'Bearer' || !token)
		return res.status(401).json({ error: 'Formato de token inválido' });

	const secret = process.env.JWT_SECRET;
	try
	{
		const decoded = jwt.verify(token, secret);
		req.user = decoded;
		next();
	}
	catch (err)
	{
		return res.status(401).json({
			error: "Token inválido"
		});
	}
};