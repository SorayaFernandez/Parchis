const vault = require('node-vault')({
	apiVersion: 'v1',
	endpoint: process.env.VAULT_ADDR || 'http://vault:8200',
});

const fs = require('fs');

function getSecretData(secret) {
	const data = secret?.data?.data ?? secret?.data;
	if (!data) {
		throw new Error('Vault secret did not return usable data');
	}
	return data;
}

function readCredentialFile(filePath) {
	try {
		return fs.readFileSync(filePath, 'utf8').trim();
	} catch (err) {
		return undefined;
	}
}

async function loadSecretsIntoEnv() {
	const roleId = readCredentialFile('/vault/creds/role-id' || process.env.VAULT_ROLE_ID);
	const secretId = readCredentialFile('/vault/creds/secret-id' || process.env.VAULT_SECRET_ID);

	if (!roleId || !secretId) {
		throw new Error('VAULT_ROLE_ID and VAULT_SECRET_ID are required for AppRole authentication');
	}

	const login = await vault.approleLogin({
		role_id: roleId,
		secret_id: secretId,
	});
	vault.token = login.auth.client_token;

	const vaultPath = (process.env.VAULT_SECRET_PATH || 'secret/data/transcendence').replace(/\/+$/, '');

	const db = await vault.read(`${vaultPath}/db`);
	const jwt = await vault.read(`${vaultPath}/jwt`);

	const dbData = getSecretData(db);
	const jwtData = getSecretData(jwt);

	process.env.DB_USER = dbData.username;
	process.env.DB_PASSWORD = dbData.password;
	process.env.JWT_SECRET = jwtData.secret;

	console.log('🔐 Secretos cargados desde Vault');
}

module.exports = { loadSecretsIntoEnv };