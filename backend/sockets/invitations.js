const invitations = new Map();

function createInvitation(invite)
{
	invitations.set(invite.id, invite);
}

function getInvitation(id)
{
	return invitations.get(id);
}

function deleteInvitation(id)
{
	invitations.delete(id);
}

function removeInvitationsByUser(userId)
{
	for (const [id, invite] of invitations)
	{
		if (invite.from === userId || invite.to === userId)
			invitations.delete(id);
	}
}

function invitationExists(id)
{
	return invitations.has(id);
}

module.exports = {
	createInvitation,
	getInvitation,
	deleteInvitation,
	removeInvitationsByUser,
	invitationExists
};