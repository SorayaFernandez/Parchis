const { loadSecretsIntoEnv } = require('./bootstrap');

loadSecretsIntoEnv()
	.then(() => {
		require('./server'); // recién aquí se cargan db.js, initDb.js, rutas, sockets...
	})
	.catch((err) => {
		console.error('❌ No se pudieron cargar los secretos de Vault:', err);
		process.exit(1);
	});