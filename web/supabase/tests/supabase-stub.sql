-- SOLO PARA PRUEBAS LOCALES (PostgreSQL desechable). NO ejecutar en Supabase.
-- Imitación mínima de lo que `8.2a-chat.sql` necesita de Supabase: roles, publicación de Realtime,
-- privilegios por defecto y `public.games` con sus columnas y un trigger de guarda simplificado
-- (el real es `games_guard`; aquí solo reproduce lo necesario: versión + 1 con el mismo token).

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  state jsonb not null,
  engine_version integer not null default 1,
  status text not null default 'playing',
  winner text,
  version integer not null default 1,
  lock_token uuid,
  processing_until timestamptz,
  last_action jsonb,
  last_events jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create function public.games_guard() returns trigger language plpgsql as $$
begin
  if new.version <> old.version then
    if new.version <> old.version + 1 or new.lock_token is distinct from old.lock_token then
      raise exception 'games_guard: versión o reserva no válidas' using errcode = '55P03';
    end if;
    new.lock_token := null;
    new.processing_until := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger games_guard before update on public.games for each row execute function public.games_guard();
grant all on public.games to service_role;
