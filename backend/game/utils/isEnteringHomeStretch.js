const getDistanceToHomeEntry = require('./getDistanceToHomeEntry');

function isEnteringHomeStretch(color, currentSteps, dice)
{
	const distance = getDistanceToHomeEntry(color, currentSteps);
	return dice > distance;
}

module.exports = isEnteringHomeStretch;