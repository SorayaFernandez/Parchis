// Cliente de Supabase para el navegador: URL + clave publicable (rol `anon`).
// Con las políticas de `public.games` solo puede leer y suscribirse a Realtime.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parsePublicSupabaseEnv } from "./env";

let client: SupabaseClient | null = null;

/**
 * Cliente único del navegador, creado la primera vez que se usa (así el build y las
 * pruebas no necesitan las variables). Sin sesión: no hay autenticación.
 */
export function getBrowserSupabase(): SupabaseClient {
  if (client) return client;

  // Lectura literal de cada variable: Next.js solo incrusta en el bundle del navegador
  // las `NEXT_PUBLIC_*` escritas así (no `process.env` completo ni con nombres dinámicos).
  const env = parsePublicSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  client = createClient(env.url, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
