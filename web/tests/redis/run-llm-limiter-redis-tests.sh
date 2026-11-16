#!/usr/bin/env bash
# Pruebas del limitador global de AI Gateway (scripts Lua) contra un Redis 7 DESECHABLE en Docker.
# NO se conecta a Upstash. Uso (desde web/): bash tests/redis/run-llm-limiter-redis-tests.sh
# Crea el contenedor (puerto aleatorio en 127.0.0.1), ejecuta limiterScripts.redis.test.ts con
# REDIS_TEST_URL y borra el contenedor al terminar. Termina con código distinto de cero si algo falla.
set -euo pipefail

WEB="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="parchis-llm-limiter-redis-$$"
IMAGE="redis:7-alpine"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --rm --name "$NAME" -p 127.0.0.1::6379 "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if [ "$(docker exec "$NAME" redis-cli ping 2>/dev/null || true)" = "PONG" ]; then break; fi
  sleep 0.5
done
[ "$(docker exec "$NAME" redis-cli ping 2>/dev/null || true)" = "PONG" ] || { echo "FALLA: Redis no arrancó a tiempo"; exit 1; }
PORT="$(docker port "$NAME" 6379/tcp | head -1 | sed 's/.*://')"

cd "$WEB"
REDIS_TEST_URL="redis://127.0.0.1:${PORT}" npx vitest run src/lib/llm/__tests__/limiterScripts.redis.test.ts
echo "PRUEBAS DEL LIMITADOR CONTRA REDIS REAL COMPLETADAS"
