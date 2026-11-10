function createPieces()
{
	return Array.from({ length: 4 }).map((_, index) => ({
		id: index,
		state: 'base',
		steps: -1
	}));
}

module.exports = createPieces;