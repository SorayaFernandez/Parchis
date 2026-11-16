-- SOLO PARA PRUEBAS LOCALES (PostgreSQL desechable). NO ejecutar en Supabase.
-- Imitación mínima del entorno que Supabase ya trae: roles, publicación de Realtime, privilegios por
-- defecto y uso del esquema `public`. NO define `public.games`: su esquema real (columnas generadas,
-- restricciones, `games_guard`, RLS, permisos y Realtime) lo crea `../6.1-games.sql`, que
-- `run-chat-sql-tests.sh` aplica después de este archivo y antes de `../8.2a-chat.sql`. Así solo
-- hay una definición de `games`.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
