// Validación de las variables de entorno de Supabase.
// Funciones puras: reciben el objeto de variables (no leen `process.env` directamente),
// así se pueden probar y el módulo no arrastra secretos a ningún bundle.
// Los mensajes de error nombran la variable, nunca su valor.

import { z } from "zod";

type EnvSource = Readonly<Record<string, string | undefined>>;

const PUBLISHABLE_PREFIX = "sb_publishable_";
const SECRET_PREFIX = "sb_secret_";

const urlSchema = z
  .url({
    protocol: /^https?$/,
    error: "debe ser la URL del proyecto (https://<ref>.supabase.co)",
  })
  // supabase-js añade las rutas (/rest/v1, /realtime/v1…): con una ruta en la URL base,
  // todas las peticiones darían 404. Error típico: copiar la URL del endpoint REST.
  .refine(
    (value) => {
      // En Zod 4 el refine se ejecuta aunque `z.url()` haya fallado: si no es URL, ya hay error.
      if (!URL.canParse(value)) return true;
      const url = new URL(value);
      return url.pathname === "/" && url.search === "" && url.hash === "";
    },
    { error: "debe ser la URL base del proyecto, sin ruta (quita /rest/v1/ u otras rutas)" },
  );

const keySchema = (prefix: string) =>
  z.string().trim().startsWith(prefix, { error: `debe empezar por "${prefix}"` });

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlSchema,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keySchema(PUBLISHABLE_PREFIX),
});

const secretSchema = z.object({
  SUPABASE_SECRET_KEY: keySchema(SECRET_PREFIX),
});

export interface PublicSupabaseEnv {
  url: string;
  publishableKey: string;
}

export interface ServerSupabaseEnv extends PublicSupabaseEnv {
  secretKey: string;
}

/** Error de configuración: indica qué variables faltan o son incorrectas (sin mostrar valores). */
export class SupabaseEnvError extends Error {
  override name = "SupabaseEnvError";
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const name = String(issue.path[0] ?? "?");
      return issue.code === "invalid_type" ? `${name}: falta` : `${name}: ${issue.message}`;
    })
    .join("; ");
}

function parse<T>(schema: z.ZodType<T>, source: EnvSource): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new SupabaseEnvError(
      `Configuración de Supabase incorrecta (${describeIssues(result.error)}). Revisa web/.env.local (ver web/.env.example).`,
    );
  }
  return result.data;
}

/** URL y clave publicable (seguras para el navegador). */
export function parsePublicSupabaseEnv(source: EnvSource): PublicSupabaseEnv {
  const env = parse(publicSchema, source);
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
}

/**
 * Variables del servidor: las públicas más la clave secreta.
 * Falla también si alguna variable `NEXT_PUBLIC_` contiene una clave secreta,
 * porque Next.js las incrusta en el código que llega al navegador.
 */
export function parseServerSupabaseEnv(source: EnvSource): ServerSupabaseEnv {
  const leaked = Object.entries(source)
    .filter(([name, value]) => name.startsWith("NEXT_PUBLIC_") && value?.trim().startsWith(SECRET_PREFIX))
    .map(([name]) => name);
  if (leaked.length > 0) {
    throw new SupabaseEnvError(
      `La clave secreta no puede ir en variables NEXT_PUBLIC_ (${leaked.join(", ")}): se expondría en el navegador.`,
    );
  }

  const publicEnv = parsePublicSupabaseEnv(source);
  const { SUPABASE_SECRET_KEY } = parse(secretSchema, source);
  return { ...publicEnv, secretKey: SUPABASE_SECRET_KEY };
}
