-- Pruebas de `chat_commit` (8.2a-chat.sql): persistencia de `director_state` sin mensajes.
-- SOLO PARA PRUEBAS LOCALES: lo ejecuta `run-chat-sql-tests.sh` sobre un PostgreSQL desechable, después
-- de `supabase-stub.sql`, `8.2a-chat.sql` y `8.2a-chat.test.sql`. Usa su propia partida y sus propias
-- funciones auxiliares (las de `pg_temp` no pasan de una sesión de psql a otra). No modifica el SQL.
--
-- Por qué importa (fase 8.2b, continuidad del historial): cuando una versión defectuosa se salta sin
-- llamar al director, el lote se confirma SIN mensajes y con el estado del director sin cambios; la
-- versión observada siguiente detecta el hueco y su lote guarda el estado nuevo, a menudo también sin
-- mensajes. Estas pruebas comprueban sobre el SQL real que `chat_commit` guarda `director_state` con
-- `p_messages = []` y que el cursor y el estado cambian en la misma operación (o ninguno de los dos).

\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FALLA: %', what; end if;
  raise notice 'OK: %', what;
end;
$$;

-- Avance de la partida de estas pruebas como lo hace la aplicación (versión + 1, rol del servidor).
create function pg_temp.advance2() returns integer language plpgsql as $$
declare v integer;
begin
  set local role service_role;
  update public.games set version = version + 1, state = jsonb_build_object('v', version + 1), last_events = '[]'
   where id = 'dddddddd-0000-4000-8000-000000000001'
  returning version into v;
  reset role;
  return v;
end;
$$;

insert into public.games (id, state) values ('dddddddd-0000-4000-8000-000000000001', '{"v":1}');

-- ─── S1. Confirmación sin mensajes: guarda el estado, avanza el cursor y vacía el lote ────────
do $$
declare
  g uuid := 'dddddddd-0000-4000-8000-000000000001';
  n integer; through integer; r record; c record;
  st jsonb := '{"observedThrough":4,"historyGapThrough":null,"marca":"s1"}';
begin
  perform pg_temp.advance2(); perform pg_temp.advance2(); perform pg_temp.advance2(); -- v2, v3, v4
  set local role service_role;
  select count(*), max(t.through) into n, through from public.chat_claim(g, 'dddddddd-0000-4000-8000-0000000000a1', 10, 25) as t;
  perform pg_temp.check(n = 3 and through = 4, 'S1a. lote de 3 versiones (2…4)');
  select * into r from public.chat_commit(g, 'dddddddd-0000-4000-8000-0000000000a1', 4, st, '[]', 60);
  perform pg_temp.check(r.inserted = 0 and r.has_more = false, 'S1b. confirmación con p_messages = []: 0 insertados, sin pendientes');
  reset role;
  select * into c from public.game_chat where game_id = g;
  perform pg_temp.check(c.director_state = st, 'S1c. director_state guardado aunque no haya mensajes');
  perform pg_temp.check(c.last_version = 4 and c.message_count = 0, 'S1d. cursor en la 4 y sin mensajes contados');
  perform pg_temp.check(c.lock_token is null and c.locked_until is null and c.locked_through is null, 'S1e. reserva liberada');
  perform pg_temp.check((select count(*) from public.game_chat_queue where game_id = g) = 0, 'S1f. cola vacía');
  perform pg_temp.check((select count(*) from public.game_messages where game_id = g) = 0, 'S1g. ningún mensaje');
end $$;

-- ─── S2. Confirmación parcial sin mensajes: el estado se guarda con el cursor en `p_through` ───
do $$
declare
  g uuid := 'dddddddd-0000-4000-8000-000000000001';
  n integer; r record; c record;
  st jsonb := '{"observedThrough":5,"historyGapThrough":null,"marca":"s2"}';
begin
  perform pg_temp.advance2(); perform pg_temp.advance2(); perform pg_temp.advance2(); -- v5, v6, v7
  set local role service_role;
  select count(*) into n from public.chat_claim(g, 'dddddddd-0000-4000-8000-0000000000a2', 10, 25);
  perform pg_temp.check(n = 3, 'S2a. lote de 3 versiones (5…7)');
  select * into r from public.chat_commit(g, 'dddddddd-0000-4000-8000-0000000000a2', 6, st, '[]', 60);
  perform pg_temp.check(r.inserted = 0 and r.has_more = true, 'S2b. confirmación parcial hasta la 6, sin mensajes: queda la 7');
  reset role;
  select * into c from public.game_chat where game_id = g;
  perform pg_temp.check(c.last_version = 6 and c.director_state = st, 'S2c. cursor en la 6 y estado de la confirmación, juntos');
  perform pg_temp.check(
    (select string_agg(version::text, ',' order by version) from public.game_chat_queue where game_id = g) = '7',
    'S2d. en la cola solo queda la 7');
end $$;

-- ─── S3. Cursor y estado cambian juntos o ninguno: rechazos y errores no dejan nada a medias ────
do $$
declare
  g uuid := 'dddddddd-0000-4000-8000-000000000001';
  n integer; c record; failed boolean := false;
  before_state jsonb := '{"observedThrough":5,"historyGapThrough":null,"marca":"s2"}';
  bad_msg jsonb := '[{"version":3,"seq":0,"character_id":"ai-pink","trigger":"capture","reply_to_seq":null,"text":"¡A casa!","source":"local"}]';
begin
  set local role service_role;
  select count(*) into n from public.chat_claim(g, 'dddddddd-0000-4000-8000-0000000000a3', 10, 25);
  perform pg_temp.check(n = 1, 'S3a. lote con la versión pendiente (7)');
  -- Token ajeno: sin filas y sin cambios.
  perform pg_temp.check(not exists (select 1 from public.chat_commit(g, 'dddddddd-0000-4000-8000-0000000000ff', 7, '{"marca":"ajeno"}', '[]', 60)),
    'S3b. token ajeno: rechazada');
  -- Error a mitad (mensaje fuera del lote): la excepción deshace todo, también el estado.
  begin
    perform * from public.chat_commit(g, 'dddddddd-0000-4000-8000-0000000000a3', 7, '{"marca":"error"}', bad_msg, 60);
  exception when others then
    failed := true;
  end;
  perform pg_temp.check(failed, 'S3c. mensaje fuera del lote: chat_commit lanza un error');
  reset role;
  select * into c from public.game_chat where game_id = g;
  perform pg_temp.check(c.last_version = 6 and c.director_state = before_state,
    'S3d. tras los rechazos, ni el cursor ni el estado han cambiado');
  -- La confirmación válida (sin mensajes) sigue funcionando con la misma reserva.
  set local role service_role;
  perform pg_temp.check(
    (select t.inserted = 0 and t.has_more = false from public.chat_commit(g, 'dddddddd-0000-4000-8000-0000000000a3', 7, '{"marca":"s3"}', '[]', 60) as t),
    'S3e. confirmación válida sin mensajes tras los rechazos');
  reset role;
  select * into c from public.game_chat where game_id = g;
  perform pg_temp.check(c.last_version = 7 and c.director_state = '{"marca":"s3"}', 'S3f. cursor en la 7 y estado nuevo, juntos');
end $$;

delete from public.games where id = 'dddddddd-0000-4000-8000-000000000001';

\echo 'PRUEBAS SQL DE chat_commit (estado sin mensajes) COMPLETADAS'
