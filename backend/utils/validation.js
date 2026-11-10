const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUsername(username)
{
	if (typeof username !== "string")
		return {
			ok: false,
			error: "Username must be a string"
		};

	username = username.trim();

	if (username.length < 3)
		return {
			ok: false,
			error: "Username must contain at least 3 characters"
		};

	if (username.length > 20)
		return {
			ok: false,
			error: "Username cannot exceed 20 characters"
		};

	if (!USERNAME_REGEX.test(username))
		return {
			ok: false,
			error: "Username contains invalid characters"
		};

	return {
		ok: true,
		value: username
	};
}

function validateEmail(email)
{
	if (typeof email !== "string")
		return {
			ok: false,
			error: "Email must be a string"
		};

	email = email.trim().toLowerCase();

	if (!EMAIL_REGEX.test(email))
		return {
			ok: false,
			error: "Invalid email"
		};

	return {
		ok: true,
		value: email
	};
}

function validatePassword(password)
{
	if (typeof password !== "string")
		return {
			ok: false,
			error: "Password must be a string"
		};

	if (password.length < 8)
		return {
			ok: false,
			error: "Password must contain at least 8 characters"
		};

	if (password.length > 128)
		return {
			ok: false,
			error: "Password is too long"
		};

	return {
		ok: true,
		value: password
	};
}

function validateId(id)
{
	const number = Number(id);

	if (!Number.isInteger(number) || number <= 0)
		return {
			ok: false,
			error: "Invalid id"
		};

	return {
		ok: true,
		value: number
	};
}

function validatePieceIndex(pieceIndex)
{
	if (!Number.isInteger(pieceIndex))
		return {
			ok: false,
			error: "Invalid piece index"
		};

	if (pieceIndex < 0 || pieceIndex > 3)
		return {
			ok: false,
			error: "Piece index out of range"
		};

	return {
		ok: true,
		value: pieceIndex
	};
}

function validateText(text, maxLength = 255)
{
	if (typeof text !== "string")
		return {
			ok: false,
			error: "Invalid text"
		};

	text = text.trim();

	if (text.length === 0)
		return {
			ok: false,
			error: "Text cannot be empty"
		};

	if (text.length > maxLength)
		return {
			ok: false,
			error: "Text is too long"
		};

	return {
			ok: true,
			value: text
	};
}

module.exports = {
	validateUsername,
	validateEmail,
	validatePassword,
	validateId,
	validatePieceIndex,
	validateText
};