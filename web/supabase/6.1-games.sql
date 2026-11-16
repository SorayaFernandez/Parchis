-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Parchís IA · Fase 6.1 · Tabla `public.games` (partidas), su guarda, seguridad y Realtime
-- BORRADOR. Reproduce el estado REAL de Supabase, recuperado el 2026-11-16 con consultas de solo
-- lectura a los catálogos (Q1–Q15). No cambia el funcionamiento de la aplicación.
--
-- En Supabase la tabla YA EXISTE: este archivo sirve para versionar su definición y para crear
-- entornos nuevos (o desechables de prueba). No hace falta ejecutarlo en el proyecto actual.
--
-- ORDEN: ejecutar ANTES de `8.2a-chat.sql`, que depende de `games` (claves foráneas de las tablas
-- del chat y trigger `games_chat_enqueue`). Este archivo NO crea nada del chat: ni el trigger
-- `games_chat_enqueue` ni su función, ni `game_chat_queue`, `game_messages`, `game_chat`, sus
-- políticas, funciones o publicación. Todo eso es de `8.2a-chat.sql`.
--
-- Contenido:
-- · Tabla con sus 13 columnas en el orden real. `status` y `winner` son columnas GENERADAS (STORED)
--   a partir de `state`; `finished_at` lo fija `games_guard` (nunca la aplicación).
-- · Restricciones CHECK y clave primaria con sus nombres reales, e índice (status, updated_at desc).
-- · `games_guard()` (BEFORE INSERT OR UPDATE): partida nueva en la versión 1; reserva del turno de
--   20 s con el reloj de PostgreSQL; confirmación solo con versión + 1, el mismo token y la reserva
--   vigente; `finished_at` al terminar. Conflictos de reserva → 55P03 (lock_not_available).
-- · RLS activada (no forzada) con lectura pública; escritura solo `service_role`.
-- · Permisos exactos de la tabla y de la función (independientes de los privilegios por defecto).
-- · Publicación `supabase_realtime` (la publicación la crea Supabase; aquí solo se añade la tabla).
--
-- `gen_random_uuid()` es una función nativa de PostgreSQL (≥ 13, en `pg_catalog`): no necesita
-- ninguna extensión. En Supabase también existe `extensions.gen_random_uuid()` (pgcrypto), pero el
-- default real usa la de `pg_catalog`.
--
-- Idempotente: se puede volver a ejecutar sin errores. Con la tabla ya creada, `create table if not
-- exists` no la toca (no compara su definición), y el resto vuelve a dejar la función, el trigger,
-- los permisos, la política y la publicación como aquí se definen.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ─── Tabla ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.games (
  id                uuid not null default gen_random_uuid(),
  -- Estado completo del motor (GameState).
  state             jsonb not null,
  -- Formato del estado guardado (ENGINE_STATE_VERSION de la aplicación).
  engine_version    smallint not null default 1,
  -- Derivadas del estado: nunca se escriben directamente.
  status            text generated always as (state ->> 'status') stored,
  winner            text generated always as (state ->> 'winner') stored,
  -- Sube de 1 en 1 con cada acción confirmada (la 1 es la creación).
  version           integer not null default 1,
  -- Reserva del turno: token del proceso y fin del plazo (los dos o ninguno).
  lock_token        uuid,
  processing_until  timestamptz,
  -- Acción y eventos que llevaron a esta versión.
  last_action       jsonb,
  last_events       jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Lo fija `games_guard` al confirmar una versión con la partida terminada.
  finished_at       timestamptz,
  constraint games_pkey primary key (id),
  constraint games_engine_version_pos check (engine_version >= 1),
  constraint games_finished_consistent check ((status = 'finished') = (finished_at is not null)),
  constraint games_last_action_object check (last_action is null or jsonb_typeof(last_action) = 'object'),
  constraint games_last_events_array check (jsonb_typeof(last_events) = 'array'),
  constraint games_lock_consistent check ((lock_token is null) = (processing_until is null)),
  constraint games_state_is_object check (jsonb_typeof(state) = 'object'),
  constraint games_status_valid check (status is not null and status in ('playing', 'finished')),
  constraint games_version_pos check (version >= 1)
);

comment on table public.games is
  'Partidas de Parchís IA. Solo el servidor (service_role) escribe; lectura pública para observar.';

create index if not exists games_status_updated_at_idx on public.games (status, updated_at desc);

-- REPLICA IDENTITY por defecto (clave primaria), como en Supabase.
alter table public.games replica identity default;

-- ─── Guarda: creación, reserva y confirmación ─────────────────────────────────────────────
-- Cuerpo copiado literalmente de `pg_get_functiondef` (Supabase). SECURITY INVOKER, search_path vacío.
create or replace function public.games_guard()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
  begin
    if tg_op = 'INSERT' then
      if new.version <> 1
         or new.lock_token is not null or new.processing_until is not null
         or new.last_action is not null or new.last_events <> '[]'::jsonb
         or coalesce(new.state ->> 'status', '') <> 'playing' then
        raise exception 'games: una partida nueva empieza en la versión 1, en juego y sin reserva'
          using errcode = 'check_violation';
      end if;
      new.created_at  := now();
      new.updated_at  := now();
      new.finished_at := null;
      return new;
    end if;

    -- UPDATE ------------------------------------------------------------------
    if new.id <> old.id
       or new.created_at <> old.created_at
       or new.engine_version <> old.engine_version then
      raise exception 'games: id, created_at y engine_version son inmutables'
        using errcode = 'check_violation';
    end if;
    -- a) Reserva o liberación (misma versión)
    if new.version = old.version then
      if new.state       is distinct from old.state
         or new.last_action is distinct from old.last_action
         or new.last_events is distinct from old.last_events then
        raise exception 'games: el estado solo cambia aumentando la versión'
          using errcode = 'check_violation';
      end if;

      if new.lock_token is not null and new.lock_token is distinct from old.lock_token then
        -- Reserva nueva
        if old.state ->> 'status' <> 'playing' then
          raise exception 'games: la partida ha terminado' using errcode = 'lock_not_available';
        end if;
        if old.lock_token is not null and old.processing_until > now() then
          raise exception 'games: el turno ya está reservado' using errcode = 'lock_not_available';
        end if;
        -- PLAZO DE LA RESERVA (único punto). 20 s basta para tirar/mover sin IA.
        -- Al incorporar llamadas reales a IA: ampliar este intervalo y/o permitir
        -- renovar la reserva en la rama "mismo token" de abajo.
        new.processing_until := now() + interval '20 seconds';
      elsif new.lock_token is null then
        -- Liberación
        new.processing_until := null;
      else
        -- Mismo token: el plazo no se puede alargar ni modificar
        -- (aquí se añadiría la renovación si se necesita en el futuro).
        new.processing_until := old.processing_until;
      end if;

      new.updated_at  := old.updated_at;
      new.finished_at := old.finished_at;
      return new;
    end if;

    -- b) Confirmación de una acción (versión + 1)
    if new.version = old.version + 1 then
      if old.lock_token is null or old.processing_until <= now() then
        raise exception 'games: no hay reserva vigente' using errcode = 'lock_not_available';
      end if;
      if new.lock_token is distinct from old.lock_token then
        raise exception 'games: la reserva pertenece a otro proceso' using errcode = 'lock_not_available';
      end if;
      if old.state ->> 'status' <> 'playing' then
        raise exception 'games: la partida ha terminado' using errcode = 'lock_not_available';
      end if;
      if new.last_action is null then
        raise exception 'games: falta last_action' using errcode = 'check_violation';
      end if;

      new.lock_token       := null;   -- la confirmación libera la reserva
      new.processing_until := null;
      new.updated_at       := now();
      new.finished_at      := case when new.state ->> 'status' = 'finished' then now() end;
      return new;
    end if;

    raise exception 'games: la versión solo puede aumentar de 1 en 1'
      using errcode = 'check_violation';
  end;
  $function$;

-- Solo la ejecuta su propietario (ACL real: {postgres=X/postgres}). Un trigger no necesita EXECUTE
-- de quien hace el UPDATE; así no queda ejecutable para nadie más, sean cuales sean los
-- privilegios por defecto del entorno.
revoke all on function public.games_guard() from public, anon, authenticated, service_role;

drop trigger if exists games_guard on public.games;
create trigger games_guard
  before insert or update on public.games
  for each row
  execute function public.games_guard();

-- ─── Seguridad: RLS y permisos ────────────────────────────────────────────────────────────
alter table public.games enable row level security;

-- Permisos explícitos (ACL real: postgres=arwdDxtm, anon=r, authenticated=r, service_role=arw).
-- Primero se quita todo lo que hubieran concedido los privilegios por defecto del entorno.
revoke all on table public.games from public, anon, authenticated, service_role;
grant select on table public.games to anon, authenticated;
grant select, insert, update on table public.games to service_role;

-- Lectura pública. Sin políticas de escritura: solo escribe service_role (ignora RLS).
drop policy if exists games_public_read on public.games;
create policy games_public_read on public.games
  as permissive
  for select to anon, authenticated
  using (true);

-- ─── Realtime ─────────────────────────────────────────────────────────────────────────────
-- Cambios de `games` (el navegador se suscribe a los UPDATE de una partida). Sin lista de columnas:
-- PostgreSQL 17 no publica las columnas generadas (`status`, `winner`), igual que en Supabase.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end;
$$;

commit;
