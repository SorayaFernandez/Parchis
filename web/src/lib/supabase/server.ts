// Cliente de Supabase para el servidor: URL + clave secreta (rol `service_role`, ignora RLS).
// Es el único que puede escribir en `public.games`. Nunca debe llegar al navegador:
// `server-only` hace fallar el build si un Client Component lo importa.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseServerSupabaseEnv } from "./env";

let client: SupabaseClient | null = null;

/** Cliente único del servidor, creado la primera vez que se usa. Sin sesión ni refresco de tokens. */
export function getServerSupabase(): SupabaseClient {
  if (client) return client;

  const env = parseServerSupabaseEnv(process.env);
  client = createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
