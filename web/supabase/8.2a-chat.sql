-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Parchís IA · Fase 8.2a · Chat entre personajes (con cola persistente)
-- PARA REVISAR Y EJECUTAR A MANO en el editor SQL de Supabase. La aplicación no lo ejecuta.
--
-- · `games`: NO se modifican sus columnas, sus políticas ni el trigger `games_guard`. Se AÑADE un
--   trigger TOLERANTE `games_chat_enqueue` (AFTER UPDATE) que registra cada versión confirmada en la
--   cola, en la misma transacción que la confirmación del avance (nunca se encola una versión que no
--   llegó a confirmarse). Si el encolado falla, emite un WARNING y el avance SIGUE ADELANTE: ese
--   acontecimiento se pierde para el chat y no se puede recuperar mediante la cola.
-- · `game_chat_queue`: versiones pendientes de procesar por el chat (idempotente por partida+versión).
-- · `game_messages`: historial del chat. Lectura pública (RLS) y Realtime; escritura solo servidor.
-- · `game_chat`: cursor (última versión procesada), contadores, estado del director y reserva.
-- · Funciones atómicas con el reloj de PostgreSQL, ejecutables solo por `service_role`.
-- Idempotente: se puede volver a ejecutar sin errores.
--
-- Para DESACTIVAR el chat: `drop trigger if exists games_chat_enqueue on public.games;`
-- (recomendado antes de borrar `game_chat_queue`; sin la tabla, la partida sigue, pero cada avance
-- emitiría un WARNING).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ─── Cola de versiones pendientes ─────────────────────────────────────────────────────────
create table if not exists public.game_chat_queue (
  game_id     uuid not null references public.games (id) on delete cascade,
  -- Versión confirmada (la 1 es la creación: no tiene eventos y no se encola).
  version     integer not null,
  -- Eventos y estado de esa versión (copiados de `games` al confirmar; `games` solo guarda la última).
  events      jsonb not null,
  state       jsonb not null,
  -- La versión de la victoria (alguien termina 1.º): nunca se descarta por antigüedad ni por intentos.
  is_victory  boolean not null default false,
  -- Veces que ha encabezado un lote reservado. Si una versión falla, el procesador confirma las
  -- anteriores y la siguiente reserva empieza en ella: solo la defectuosa acumula intentos.
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  primary key (game_id, version)
);

-- ─── Historial de mensajes ────────────────────────────────────────────────────────────────
create table if not exists public.game_messages (
  -- Orden global de inserción: cursor para recuperar "todo lo posterior a id X".
  id            bigint generated always as identity primary key,
  game_id       uuid not null references public.games (id) on delete cascade,
  -- Versión de la partida cuyo acontecimiento originó el mensaje.
  version       integer not null check (version >= 1),
  -- Orden dentro de la versión: 0 = mensaje, 1 = réplica.
  seq           smallint not null check (seq between 0 and 3),
  character_id  text not null check (character_id ~ '^ai-[a-z]+$'),
  trigger       text not null check (trigger in (
                  'victory', 'capture', 'capture_streak', 'bad_streak',
                  'third_six', 'finish_place', 'goal', 'ambient')),
  reply_to_seq  smallint check (reply_to_seq is null or (reply_to_seq >= 0 and reply_to_seq < seq)),
  text          text not null check (char_length(text) between 1 and 200),
  -- 'local' = frase del catálogo; 'llm' = generado (fase 8.2b).
  source        text not null default 'local' check (source in ('local', 'llm')),
  created_at    timestamptz not null default now(),
  -- Un reintento nunca duplica mensajes.
  constraint game_messages_version_seq_key unique (game_id, version, seq)
);

-- Carga inicial (últimos N) y recuperación (id > X) de una partida.
create index if not exists game_messages_game_id_id_idx on public.game_messages (game_id, id);

-- ─── Estado del chat por partida ──────────────────────────────────────────────────────────
create table if not exists public.game_chat (
  game_id         uuid primary key references public.games (id) on delete cascade,
  -- Cursor: última versión procesada. Solo avanza al confirmar un lote completo.
  last_version    integer not null default 0 check (last_version >= 0),
  message_count   integer not null default 0 check (message_count between 0 and 1000),
  -- Estado del director (últimas intervenciones, capturas recientes, textos recientes). Sin datos personales.
  director_state  jsonb not null default '{}'::jsonb check (jsonb_typeof(director_state) = 'object'),
  -- Reserva de UN lote: (last_version, locked_through]. Caduca sola (locked_until).
  lock_token      uuid,
  locked_until    timestamptz,
  locked_through  integer,
  updated_at      timestamptz not null default now(),
  constraint game_chat_lock_fields check (
    (lock_token is null and locked_until is null and locked_through is null)
    or (lock_token is not null and locked_until is not null and locked_through > last_version)
  )
);

-- ─── Registro en la cola: trigger TOLERANTE en `games` ────────────────────────────────────
-- Se ejecuta dentro de la transacción del UPDATE que confirma la versión (advance → commit), solo
-- cuando la versión sube (las reservas y liberaciones de `games` no cambian la versión).
-- Decisión: un fallo del chat nunca debe detener la partida. Por eso el INSERT va en un bloque
-- con EXCEPTION (una subtransacción): si falla (cola inexistente, permisos, restricciones u otro
-- error de PostgreSQL), se deshace SOLO ese INSERT, se emite un WARNING con la partida, la versión
-- y el código de error, y la confirmación del avance continúa.
-- CONSECUENCIA: esa versión no entra en la cola y su acontecimiento se pierde para el chat sin
-- posibilidad de recuperación (el procesador ya admite huecos en la cola).
-- El bloque cubre únicamente este INSERT. `WHEN others` no incluye la cancelación de la sentencia
-- (statement_timeout, cancelación manual) ni los asserts: esos siguen abortando el avance, como
-- lo harían sin este trigger. Los errores del resto del avance (p. ej. `games_guard`) no pasan por aquí.
create or replace function public.games_chat_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.game_chat_queue (game_id, version, events, state, is_victory)
    values (
      new.id,
      new.version,
      coalesce(new.last_events, '[]'::jsonb),
      new.state,
      coalesce(jsonb_typeof(new.last_events) = 'array' and exists (
        select 1 from jsonb_array_elements(new.last_events) as e
         where e ->> 'type' = 'player_finished' and e ->> 'place' = '1'
      ), false)
    )
    on conflict (game_id, version) do nothing;
  exception when others then
    raise warning 'chat: versión % de la partida % no encolada (%: %); el avance continúa',
      new.version, new.id, sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists games_chat_enqueue on public.games;
create trigger games_chat_enqueue
  after update of version on public.games
  for each row
  when (new.version > old.version)
  execute function public.games_chat_enqueue();

-- ─── Permisos y RLS ───────────────────────────────────────────────────────────────────────
alter table public.game_chat_queue enable row level security;
alter table public.game_messages enable row level security;
alter table public.game_chat enable row level security;

-- Supabase concede por defecto todos los privilegios a anon/authenticated en tablas nuevas de public.
revoke all on table public.game_chat_queue, public.game_messages, public.game_chat from anon, authenticated;
grant select on table public.game_messages to anon, authenticated;
grant all on table public.game_chat_queue, public.game_messages, public.game_chat to service_role;

-- Lectura pública del chat (como `games`). Sin políticas de escritura: solo service_role (ignora RLS).
drop policy if exists game_messages_public_read on public.game_messages;
create policy game_messages_public_read on public.game_messages
  for select to anon, authenticated using (true);
-- `game_chat` y `game_chat_queue`: RLS activado y ninguna política → inaccesibles para anon/authenticated.

-- ─── Funciones del procesador ─────────────────────────────────────────────────────────────

-- Versión anterior (sin cola) de `chat_claim`: se elimina si existe.
drop function if exists public.chat_claim(uuid, integer, uuid, integer);
drop function if exists public.chat_commit(uuid, uuid, integer, jsonb, jsonb, integer);

-- Reserva el SIGUIENTE LOTE de versiones pendientes (en orden, hasta `p_batch_size`).
-- Devuelve una fila por versión del lote (con el estado del chat repetido en cada una), o ninguna
-- si no hay pendientes o hay otra reserva vigente. Las reservas abandonadas caducan a los
-- `p_lease_seconds` y cualquiera puede volver a tomarlas. Suma 1 a `attempts` de la PRIMERA
-- versión del lote (la única que puede estar bloqueando).
-- Concurrencia: el UPDATE bloquea la fila de `game_chat`; una petición simultánea espera y, al
-- reevaluar el WHERE con la reserva ya puesta, no obtiene nada.
create or replace function public.chat_claim(
  p_game_id uuid,
  p_token uuid,
  p_lease_seconds integer default 10,
  p_batch_size integer default 25
)
returns table (
  version integer, events jsonb, state jsonb, is_victory boolean, attempts integer,
  last_version integer, message_count integer, director_state jsonb, through integer, latest integer
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_last integer;
  v_count integer;
  v_state jsonb;
  v_through integer;
  v_latest integer;
begin
  if p_token is null or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 60
     or p_batch_size is null or p_batch_size < 1 or p_batch_size > 200 then
    raise exception 'chat_claim: parámetros no válidos' using errcode = '22023';
  end if;

  insert into public.game_chat (game_id) values (p_game_id) on conflict (game_id) do nothing;

  update public.game_chat as c
     set lock_token = p_token,
         locked_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         locked_through = (
           select max(b.version) from (
             select q.version from public.game_chat_queue as q
              where q.game_id = p_game_id and q.version > c.last_version
              order by q.version
              limit p_batch_size
           ) as b
         ),
         updated_at = now()
   where c.game_id = p_game_id
     and (c.lock_token is null or c.locked_until < clock_timestamp())
     and exists (select 1 from public.game_chat_queue as q where q.game_id = p_game_id and q.version > c.last_version)
  returning c.last_version, c.message_count, c.director_state, c.locked_through
       into v_last, v_count, v_state, v_through;

  if not found then
    return;
  end if;

  select max(q.version) into v_latest from public.game_chat_queue as q where q.game_id = p_game_id;

  update public.game_chat_queue as q
     set attempts = q.attempts + 1
   where q.game_id = p_game_id
     and q.version = (select min(f.version) from public.game_chat_queue as f
                       where f.game_id = p_game_id and f.version > v_last);

  return query
    select q.version, q.events, q.state, q.is_victory, q.attempts,
           v_last, v_count, v_state, v_through, v_latest
      from public.game_chat_queue as q
     where q.game_id = p_game_id and q.version > v_last and q.version <= v_through
     order by q.version;
end;
$$;

-- Confirma un lote (o la parte inicial de él) en una sola transacción: inserta los mensajes (sin
-- duplicar), borra de la cola las versiones hasta `p_through`, avanza el cursor, guarda el estado
-- del director y libera la reserva. Solo con el token de la reserva vigente (cada reserva tiene un
-- token nuevo, que identifica el lote) y `p_through` dentro del lote reservado. `p_through` menor que
-- el final del lote: el procesador se detuvo en una versión que falló, que sigue pendiente.
-- Devuelve una fila (insertados, quedan_más) o ninguna si la reserva ya no es válida (y entonces no
-- cambia nada). Si los datos no son válidos, error y nada cambia (las versiones siguen pendientes).
create or replace function public.chat_commit(
  p_game_id uuid,
  p_token uuid,
  p_through integer,
  p_state jsonb,
  p_messages jsonb,
  p_max_messages integer
)
returns table (inserted integer, has_more boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_last integer;
  v_count integer;
  v_inserted integer;
begin
  if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'chat_commit: datos no válidos' using errcode = '22023';
  end if;

  select c.last_version, c.message_count into v_last, v_count
    from public.game_chat as c
   where c.game_id = p_game_id
     and c.lock_token = p_token
     and p_through > c.last_version
     and p_through <= c.locked_through
     and c.locked_until >= clock_timestamp()
   for update;
  if not found then
    return;
  end if;

  if v_count + jsonb_array_length(p_messages) > p_max_messages then
    raise exception 'chat_commit: límite de mensajes superado' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_messages) as m
     where (m ->> 'version')::integer <= v_last or (m ->> 'version')::integer > p_through
  ) then
    raise exception 'chat_commit: mensaje fuera del lote reservado' using errcode = '22023';
  end if;

  insert into public.game_messages (game_id, version, seq, character_id, trigger, reply_to_seq, text, source)
  select p_game_id, m.version, m.seq, m.character_id, m.trigger, m.reply_to_seq, m.text, m.source
    from jsonb_to_recordset(p_messages)
      as m(version integer, seq smallint, character_id text, trigger text, reply_to_seq smallint, text text, source text)
   order by m.version, m.seq
  on conflict (game_id, version, seq) do nothing;
  get diagnostics v_inserted = row_count;

  delete from public.game_chat_queue as q
   where q.game_id = p_game_id and q.version <= p_through;

  update public.game_chat as c
     set last_version = p_through,
         message_count = c.message_count + v_inserted,
         director_state = p_state,
         lock_token = null,
         locked_until = null,
         locked_through = null,
         updated_at = now()
   where c.game_id = p_game_id;

  return query
    select v_inserted,
           exists (select 1 from public.game_chat_queue as q where q.game_id = p_game_id);
end;
$$;

-- Libera la reserva si sigue siendo de `p_token` (tras un error antes de confirmar). Las versiones
-- del lote siguen pendientes.
create or replace function public.chat_release(p_game_id uuid, p_token uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.game_chat
     set lock_token = null, locked_until = null, locked_through = null, updated_at = now()
   where game_id = p_game_id and lock_token = p_token;
$$;

-- Solo el servidor (service_role) puede ejecutarlas. La función del trigger no se puede invocar
-- directamente (devuelve `trigger`), pero tampoco se deja ejecutable para nadie más.
revoke all on function public.games_chat_enqueue() from public, anon, authenticated;
revoke all on function public.chat_claim(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.chat_commit(uuid, uuid, integer, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.chat_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_claim(uuid, uuid, integer, integer) to service_role;
grant execute on function public.chat_commit(uuid, uuid, integer, jsonb, jsonb, integer) to service_role;
grant execute on function public.chat_release(uuid, uuid) to service_role;

-- ─── Realtime ─────────────────────────────────────────────────────────────────────────────
-- Inserciones de `game_messages` (RLS de lectura pública). `game_chat` y la cola NO se publican.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_messages'
  ) then
    alter publication supabase_realtime add table public.game_messages;
  end if;
end;
$$;

commit;
