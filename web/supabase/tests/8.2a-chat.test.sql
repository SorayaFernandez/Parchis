-- Pruebas de `8.2a-chat.sql` (trigger tolerante, cola, reservas y duplicados).
-- SOLO PARA PRUEBAS LOCALES: se ejecuta con `run-chat-sql-tests.sh` sobre un PostgreSQL desechable,
-- después de `supabase-stub.sql` y `8.2a-chat.sql`. Cada comprobación aborta con error si falla.
-- Los WARNING del trigger (que SQL no puede capturar) los comprueba el script en la salida de psql.

\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FALLA: %', what; end if;
  raise notice 'OK: %', what;
end;
$$;

-- Avance como lo hace la aplicación: versión + 1 con el estado y los eventos nuevos (rol del servidor).
create function pg_temp.advance(p_events jsonb) returns integer language plpgsql as $$
declare v integer;
begin
  set local role service_role;
  update public.games set version = version + 1, state = jsonb_build_object('v', version + 1), last_events = p_events
   where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad'
  returning version into v;
  reset role;
  return v;
end;
$$;

create function pg_temp.game_version() returns integer language sql as $$
  select version from public.games where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad';
$$;
create function pg_temp.queued(v integer) returns integer language sql as $$
  select count(*)::integer from public.game_chat_queue
   where game_id = '751bb3b5-52dc-4e00-86eb-3085d4357dad' and version = v;
$$;

insert into public.games (id, state) values ('751bb3b5-52dc-4e00-86eb-3085d4357dad', '{"v":1}');

-- ─── 1. Encolado correcto ─────────────────────────────────────────────────────────────────
do $$
declare v integer; q record;
begin
  v := pg_temp.advance('[{"type":"dice_rolled","playerId":"ai-pink","value":3}]');
  select * into q from public.game_chat_queue where version = v;
  perform pg_temp.check(v = 2 and q.version = 2, '1a. avance confirmado → versión encolada');
  perform pg_temp.check(q.events = '[{"type":"dice_rolled","playerId":"ai-pink","value":3}]' and q.state = '{"v":2}', '1b. con sus eventos y su estado');
  perform pg_temp.check(q.is_victory = false and q.attempts = 0, '1c. sin victoria y sin intentos');

  v := pg_temp.advance('[{"type":"player_finished","playerId":"ai-green","place":1}]');
  perform pg_temp.check((select is_victory from public.game_chat_queue where version = v), '1d. victoria detectada (puesto 1)');
  v := pg_temp.advance('[{"type":"player_finished","playerId":"ai-pink","place":2}]');
  perform pg_temp.check(not (select is_victory from public.game_chat_queue where version = v), '1e. puesto 2 no es victoria');
  v := pg_temp.advance('{"no":"es un array"}');
  perform pg_temp.check(pg_temp.queued(v) = 1, '1f. eventos con forma inesperada: se encola igual, sin error');

  -- Reserva de `games` (misma versión): no encola nada.
  update public.games set lock_token = gen_random_uuid() where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad';
  update public.games set lock_token = null where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad';
  perform pg_temp.check((select count(*) from public.game_chat_queue) = 4, '1g. cambios sin subir la versión no se encolan');
end;
$$;

-- Un avance deshecho (rollback) no deja nada en la cola.
begin;
select pg_temp.advance('[]');
rollback;
do $$ begin
  perform pg_temp.check(pg_temp.game_version() = 5 and pg_temp.queued(6) = 0, '1h. avance deshecho → nada encolado');
end $$;

-- ─── 2. Idempotencia: ON CONFLICT DO NOTHING ──────────────────────────────────────────────
do $$
declare v integer;
begin
  -- La versión 6 ya está en la cola (p. ej., de un intento anterior): no se duplica ni se pisa.
  insert into public.game_chat_queue (game_id, version, events, state)
  values ('751bb3b5-52dc-4e00-86eb-3085d4357dad', 6, '["previa"]', '{}');
  v := pg_temp.advance('[]');
  perform pg_temp.check(v = 6 and pg_temp.queued(6) = 1, '2a. misma partida y versión: una sola fila');
  perform pg_temp.check((select events from public.game_chat_queue where version = 6) = '["previa"]', '2b. la fila existente no se modifica');
end;
$$;

-- ─── 3. Fallo del INSERT: el avance NO se revierte ────────────────────────────────────────
-- 3.1 Restricción que rechaza la fila (23514).
alter table public.game_chat_queue add constraint prueba_rechaza check (version < 0) not valid;
\echo 'ESPERADO WARNING 23514 (versión 7)'
do $$
declare v integer;
begin
  v := pg_temp.advance('[{"type":"piece_captured","playerId":"ai-pink","victimId":"ai-blue","victimPieceIndex":0,"cell":30}]');
  perform pg_temp.check(v = 7 and pg_temp.game_version() = 7, '3a. restricción violada → el avance se confirma');
  perform pg_temp.check(pg_temp.queued(7) = 0, '3b. … y esa versión NO está en la cola (se pierde)');
end;
$$;
alter table public.game_chat_queue drop constraint prueba_rechaza;

-- 3.2 Cola inexistente (42P01).
alter table public.game_chat_queue rename to game_chat_queue_oculta;
\echo 'ESPERADO WARNING 42P01 (versión 8)'
do $$ begin
  perform pg_temp.check(pg_temp.advance('[]') = 8 and pg_temp.game_version() = 8, '3c. cola inexistente → el avance se confirma');
end $$;
alter table public.game_chat_queue_oculta rename to game_chat_queue;

-- 3.3 Sin permisos (42501): la función del trigger pertenece a un rol sin acceso a la cola.
create role chat_sin_permisos nologin;
alter function public.games_chat_enqueue() owner to chat_sin_permisos;
\echo 'ESPERADO WARNING 42501 (versión 9)'
do $$ begin
  perform pg_temp.check(pg_temp.advance('[]') = 9 and pg_temp.game_version() = 9, '3d. sin permisos → el avance se confirma');
  perform pg_temp.check(pg_temp.queued(9) = 0, '3e. … y esa versión no está en la cola');
end $$;
alter function public.games_chat_enqueue() owner to postgres;

-- 3.4 Tras los fallos, el encolado vuelve a funcionar.
do $$ begin
  perform pg_temp.check(pg_temp.advance('[]') = 10 and pg_temp.queued(10) = 1, '3f. tras arreglarlo, la siguiente versión se encola');
end $$;

-- ─── 4. El manejador no oculta otros errores ──────────────────────────────────────────────
do $$
begin
  begin
    -- Saltarse una versión: lo rechaza la guarda de `games` (fuera del bloque del trigger).
    set local role service_role;
    update public.games set version = version + 2 where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad';
    raise exception 'la guarda debía rechazar el avance';
  exception when sqlstate '55P03' then
    reset role;
  end;
  perform pg_temp.check(pg_temp.game_version() = 10 and pg_temp.queued(12) = 0, '4a. el error de games_guard sigue abortando el avance (nada encolado)');
end;
$$;

-- ─── 5. Cola con huecos: reserva, confirmación y sin duplicados ──────────────────────────
do $$
declare
  n integer; through integer; r record;
  msg jsonb := '[{"version":7,"seq":0,"character_id":"ai-pink","trigger":"capture","reply_to_seq":null,"text":"¡A casa!","source":"local"}]';
begin
  set local role service_role;
  -- Pendientes: 2, 3, 4, 5, 6, 10 (la 7, 8 y 9 se perdieron). El lote las toma en orden, con el hueco.
  select count(*), max(t.through) into n, through
    from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'aaaaaaaa-0000-4000-8000-000000000001', 10, 25) as t;
  perform pg_temp.check(n = 6 and through = 10, '5a. lote con hueco: 6 versiones hasta la 10');
  perform pg_temp.check(not exists (select 1 from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'aaaaaaaa-0000-4000-8000-000000000002', 10, 25)), '5b. segunda reserva simultánea: nada');

  -- La versión 7 no está en la cola, pero está dentro del tramo reservado (2..10): se admite su mensaje.
  select * into r from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'aaaaaaaa-0000-4000-8000-000000000001', 10, '{"d":1}', msg, 60);
  perform pg_temp.check(r.inserted = 1 and r.has_more = false, '5c. confirmación: 1 mensaje, cola vacía');
  perform pg_temp.check(not exists (select 1 from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'aaaaaaaa-0000-4000-8000-000000000001', 10, '{}', msg, 60)), '5d. repetir la confirmación con el mismo token: rechazada');
  reset role;
  perform pg_temp.check((select count(*) from public.game_messages) = 1, '5e. sin mensajes duplicados');
  perform pg_temp.check((select last_version from public.game_chat) = 10 and (select count(*) from public.game_chat_queue) = 0, '5f. cursor en la 10 y cola vacía');
  perform pg_temp.check(
    (select count(*) = count(distinct (game_id, version)) from public.game_chat_queue)
    and (select count(*) = count(distinct (game_id, version, seq)) from public.game_messages),
    '5g. sin duplicados en la cola ni en los mensajes');
end;
$$;

-- ─── 6. B1: chat_commit solo confirma dentro del lote reservado ──────────────────────────
do $$
declare v integer; r record; before_cursor integer; before_queue integer;
begin
  for i in 1..5 loop v := pg_temp.advance('[]'); end loop;   -- versiones 11..15 pendientes
  set local role service_role;
  perform count(*) from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000001', 10, 3);
  reset role;
  perform pg_temp.check((select locked_through from public.game_chat) = 13, '6a. reserva de un lote de 3: versiones 11..13');
  select last_version, (select count(*) from public.game_chat_queue) into before_cursor, before_queue from public.game_chat;
  set local role service_role;
  perform pg_temp.check(not exists (select 1 from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-0000000000ff', 13, '{}', '[]', 60)), '6b. token ajeno: rechazada');
  perform pg_temp.check(not exists (select 1 from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000001', 14, '{}', '[]', 60)), '6c. through más allá del lote (14 > 13): rechazada');
  perform pg_temp.check(not exists (select 1 from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000001', 10, '{}', '[]', 60)), '6d. through ya procesado (10 ≤ cursor): rechazada');
  begin
    perform public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000001', 12, '{}',
      '[{"version":13,"seq":0,"character_id":"ai-pink","trigger":"goal","reply_to_seq":null,"text":"x","source":"local"}]', 60);
    raise exception 'debía rechazar un mensaje fuera del tramo confirmado';
  exception when sqlstate '22023' then null;
  end;
  reset role;
  perform pg_temp.check((select last_version from public.game_chat) = before_cursor
    and (select count(*) from public.game_chat_queue) = before_queue
    and (select lock_token from public.game_chat) = 'bbbbbbbb-0000-4000-8000-000000000001', '6e. tras los rechazos nada cambia y la reserva sigue siendo del dueño');
  set local role service_role;
  select * into r from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000001', 12, '{}', '[]', 60);
  reset role;
  perform pg_temp.check(r.has_more and (select last_version from public.game_chat) = 12, '6f. confirmación parcial dentro del lote (hasta la 12): aceptada');
end;
$$;

-- ─── 7. Lote máximo, orden e intentos solo en la primera versión ─────────────────────────
do $$
declare n integer; first_v integer; last_v integer;
begin
  for i in 1..30 loop perform pg_temp.advance('[]'); end loop;   -- pendientes: 13..45
  set local role service_role;
  select count(*), min(t.version), max(t.version) into n, first_v, last_v
    from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000002', 10, 25) as t;
  reset role;
  perform pg_temp.check(n = 25 and first_v = 13 and last_v = 37, '7a. lote de 25 en orden (13..37)');
  perform pg_temp.check((select attempts from public.game_chat_queue where version = 13) = 1
    and (select sum(attempts) from public.game_chat_queue) = 1, '7b. solo la primera versión del lote cuenta un intento');
end;
$$;

-- ─── 8. Proceso muerto: la reserva caduca, otro la recupera y el muerto ya no confirma ─────
do $$
declare n integer;
begin
  set local role service_role;
  perform pg_temp.check(not exists (select 1 from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000003', 10, 25)), '8a. con la reserva vigente de otro: nada');
  reset role;
  update public.game_chat set locked_until = clock_timestamp() - interval '1 second';   -- el reloj "pasa" 10 s
  set local role service_role;
  select count(*) into n from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000003', 10, 25);
  perform pg_temp.check(n = 25, '8b. reserva caducada: otro procesador recupera el lote');
  perform pg_temp.check(not exists (select 1 from public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000002', 37, '{}', '[]', 60)), '8c. el procesador muerto ya no puede confirmar');
  perform public.chat_release('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000003');
  reset role;
  perform pg_temp.check((select lock_token from public.game_chat) is null and (select count(*) from public.game_chat_queue) = 33, '8d. release libera y el lote sigue pendiente');
end;
$$;

-- ─── 8b. Reserva de 30 s (valor actual de CHAT_LIMITS.leaseSeconds) ─────────────────────────
do $$
declare until timestamptz;
begin
  set local role service_role;
  perform count(*) from public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000004', 30, 25);
  reset role;
  select locked_until into until from public.game_chat;
  perform pg_temp.check(until between clock_timestamp() + interval '29 seconds' and clock_timestamp() + interval '31 seconds',
    '8e. chat_claim acepta una reserva de 30 s y caduca a los 30 s');
  set local role service_role;
  perform public.chat_release('751bb3b5-52dc-4e00-86eb-3085d4357dad', 'bbbbbbbb-0000-4000-8000-000000000004');
  reset role;
end;
$$;

-- ─── 9. B5: qué puede hacer la clave publicable (anon/authenticated) ─────────────────────
-- Otra partida con un mensaje, para comprobar que la lectura no está limitada a una partida.
insert into public.games (id, state) values ('00000000-0000-4000-8000-000000000002', '{}');
insert into public.game_messages (game_id, version, seq, character_id, trigger, text)
values ('00000000-0000-4000-8000-000000000002', 2, 0, 'ai-blue', 'goal', '¡Ficha en meta! ¡Gooool!');
do $$
declare r text; total integer;
begin
  select count(*) into total from public.game_messages;
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set local role %I', r);
    perform pg_temp.check((select count(*) from public.game_messages) = total, format('9a. %s lee los mensajes de TODAS las partidas (lectura pública, sin filtro obligatorio)', r));
    begin insert into public.game_messages (game_id, version, seq, character_id, trigger, text) values ('00000000-0000-4000-8000-000000000002', 3, 0, 'ai-pink', 'goal', 'x');
      raise exception 'escribió'; exception when insufficient_privilege then null; end;
    begin update public.game_messages set text = 'x'; raise exception 'modificó'; exception when insufficient_privilege then null; end;
    begin delete from public.game_messages; raise exception 'borró'; exception when insufficient_privilege then null; end;
    begin perform count(*) from public.game_chat; raise exception 'leyó game_chat'; exception when insufficient_privilege then null; end;
    begin perform count(*) from public.game_chat_queue; raise exception 'leyó la cola'; exception when insufficient_privilege then null; end;
    begin perform public.chat_claim('751bb3b5-52dc-4e00-86eb-3085d4357dad', gen_random_uuid(), 10, 25); raise exception 'reservó'; exception when insufficient_privilege then null; end;
    begin perform public.chat_commit('751bb3b5-52dc-4e00-86eb-3085d4357dad', gen_random_uuid(), 1, '{}', '[]', 60); raise exception 'confirmó'; exception when insufficient_privilege then null; end;
    begin perform public.chat_release('751bb3b5-52dc-4e00-86eb-3085d4357dad', gen_random_uuid()); raise exception 'liberó'; exception when insufficient_privilege then null; end;
    reset role;
    perform pg_temp.check(true, format('9b. %s no escribe mensajes, no ve game_chat ni la cola y no ejecuta las funciones', r));
  end loop;
end;
$$;

-- ─── 10. Realtime y cascada ───────────────────────────────────────────────────────────────
do $$ begin
  perform pg_temp.check(
    (select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime') = array['game_messages'],
    '10a. Realtime publica solo game_messages (ni la cola ni game_chat)');
  delete from public.games where id = '751bb3b5-52dc-4e00-86eb-3085d4357dad';
  perform pg_temp.check(
    (select count(*) from public.game_chat_queue) = 0 and (select count(*) from public.game_chat) = 0
    and (select count(*) from public.game_messages where game_id = '751bb3b5-52dc-4e00-86eb-3085d4357dad') = 0,
    '10b. borrar la partida borra su cola, su estado y sus mensajes');
end $$;

\echo 'PRUEBAS SQL COMPLETADAS'
