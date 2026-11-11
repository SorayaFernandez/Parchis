#!/usr/bin/env bash
# Pruebas del SQL del chat (fase 8.2a) sobre un PostgreSQL 17 DESECHABLE en Docker.
# NO se conecta a Supabase. Uso (desde web/): bash supabase/tests/run-chat-sql-tests.sh
# Crea el contenedor, aplica supabase-stub.sql y 8.2a-chat.sql (dos veces: idempotencia), ejecuta
# 8.2a-chat.test.sql, comprueba los WARNING del trigger tolerante y la concurrencia entre sesiones
# (reservas simultáneas y un avance que no espera al chat). Borra el contenedor al terminar.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="parchis-chat-sql-test-$$"
IMAGE="postgres:17-alpine"
OUT="$(mktemp)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$OUT" "$OUT.a" "$OUT.many"' EXIT

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 90); do
  if docker logs "$NAME" 2>&1 | grep -q "PostgreSQL init process complete" \
    && docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "FALLA: PostgreSQL no arrancó a tiempo"; exit 1; }

psql_file() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q -f - < "$1"; }

# Avisos esperados al aplicar los archivos (se omiten de la salida; todo lo demás se muestra):
# NOTICE de "if exists … skipping" y el aviso de `wal_level` al crear la publicación de prueba
# (este PostgreSQL no hace replicación lógica), con su HINT.
EXPECTED_NOISE='(NOTICE: |WARNING: +"wal_level" is insufficient|^HINT: +Set "wal_level")'

# Aplica un archivo SQL. Captura la salida de psql en un archivo, comprueba su código de salida y
# muestra la salida sin los avisos esperados. Si psql falla, muestra el error y termina el script.
apply() {
  local file="$1" log status=0
  log="$(mktemp)"
  psql_file "$file" >"$log" 2>&1 || status=$?
  sed -E "/$EXPECTED_NOISE/d" "$log"
  rm -f "$log"
  if [ "$status" -ne 0 ]; then
    echo "FALLA: psql terminó con código $status al aplicar $(basename "$file")"
    exit "$status"
  fi
}

apply "$DIR/supabase-stub.sql"
apply "$DIR/../8.2a-chat.sql"   # 1.ª aplicación
apply "$DIR/../8.2a-chat.sql"   # 2.ª aplicación: idempotencia
echo "SQL aplicado dos veces sin errores"

# stdout + stderr juntos: NOTICE (OK: …), WARNING del trigger y el resultado final.
psql_file "$DIR/8.2a-chat.test.sql" >"$OUT" 2>&1 || { cat "$OUT"; echo "FALLAN LAS PRUEBAS SQL"; exit 1; }
grep -E "OK: |ESPERADO|COMPLETADAS" "$OUT" | sed -E 's/^.*NOTICE: +//'

fail=0
for expected in "versión 7 .*\\(23514:" "versión 8 .*\\(42P01:" "versión 9 .*\\(42501:"; do
  if grep -E "WARNING: +chat: $expected" "$OUT" >/dev/null; then
    echo "OK: WARNING emitido → $(grep -E "WARNING: +chat: $expected" "$OUT" | sed -E 's/^.*WARNING: +//')"
  else
    echo "FALLA: no se emitió el WARNING esperado ($expected)"; fail=1
  fi
done
warnings=$(awk '/WARNING: +chat:/ { n++ } END { print n + 0 }' "$OUT")
if [ "$warnings" -ne 3 ]; then echo "FALLA: se esperaban 3 WARNING del chat y hubo $warnings"; fail=1; fi

# ─── Concurrencia entre sesiones (una sola sesión de psql no puede reproducirla) ───────────────
G="'aaaaaaaa-1111-4000-8000-000000000001'"
q() { docker exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -qAt -c "$1"; }
check() { if [ "$2" = "$3" ]; then echo "OK: $1"; else echo "FALLA: $1 (esperado $3, obtenido $2)"; fail=1; fi; }

q "insert into public.games (id, state) values ($G, '{}');" >/dev/null
q "do \$\$ begin for i in 1..5 loop update public.games set version = version + 1, last_events = '[]' where id = $G; end loop; end \$\$;" >/dev/null

# C1. A reserva y mantiene su transacción abierta 3 s; B lo intenta a la vez: espera y no obtiene nada.
docker exec "$NAME" psql -U postgres -qAt -c "begin; set local role service_role; select count(*) from public.chat_claim($G, 'cccccccc-0000-4000-8000-00000000000a', 10, 25); select pg_sleep(3); commit;" >"$OUT.a" 2>&1 &
sleep 1
start=$(date +%s%N)
b=$(q "set role service_role; select count(*) from public.chat_claim($G, 'cccccccc-0000-4000-8000-00000000000b', 10, 25);")
waited=$(( ($(date +%s%N) - start) / 1000000 ))
wait
check "C1a. la sesión A reserva el lote (5 versiones)" "$(head -1 "$OUT.a")" "5"
check "C1b. la sesión B, simultánea, no obtiene nada" "$b" "0"
if [ "$waited" -ge 1000 ]; then echo "OK: C1c. B esperó al bloqueo de A (${waited} ms)"; else echo "FALLA: C1c. B no esperó al bloqueo (${waited} ms)"; fail=1; fi

# C2. 10 reservas simultáneas (con la reserva libre): exactamente una gana.
q "update public.game_chat set lock_token = null, locked_until = null, locked_through = null where game_id = $G;" >/dev/null
for _ in $(seq 1 10); do
  docker exec "$NAME" psql -U postgres -qAt -c "set role service_role; select count(*) > 0 from public.chat_claim($G, gen_random_uuid(), 10, 25);" &
done >"$OUT.many" 2>&1
wait
check "C2. de 10 reservas simultáneas, ganan" "$(grep -c '^t$' "$OUT.many")" "1"

# C3. Un avance de la partida no espera al chat aunque este confirme sobre la misma cola.
q "update public.game_chat set lock_token = null, locked_until = null, locked_through = null where game_id = $G;" >/dev/null
docker exec "$NAME" psql -U postgres -qAt -c "begin; set local role service_role; select count(*) from public.chat_claim($G, 'cccccccc-0000-4000-8000-00000000000c', 10, 25); select count(*) from public.chat_commit($G, 'cccccccc-0000-4000-8000-00000000000c', 6, '{}', '[]', 60); select pg_sleep(3); commit;" >/dev/null 2>&1 &
sleep 1
start=$(date +%s%N)
q "set role service_role; update public.games set version = version + 1, last_events = '[]' where id = $G;" >/dev/null
took=$(( ($(date +%s%N) - start) / 1000000 ))
wait
if [ "$took" -lt 1000 ]; then echo "OK: C3a. avance confirmado en ${took} ms con el chat confirmando en paralelo"; else echo "FALLA: C3a. el avance esperó al chat (${took} ms)"; fail=1; fi
check "C3b. la versión nueva quedó en la cola" "$(q "select string_agg(version::text, ',') from public.game_chat_queue where game_id = $G;")" "7"
rm -f "$OUT.a" "$OUT.many"
[ "$fail" -eq 0 ] && echo "TODAS LAS PRUEBAS SQL PASAN" || exit 1
