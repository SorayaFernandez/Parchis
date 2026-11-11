// Comprobaciones de límite de cada endpoint (combinan la identidad del cliente y las reglas).

import "server-only";

import { getClientIdentity } from "./clientIp";
import { checkRateLimits, rateLimitResponse, rules, type Decision, type RateLimiter } from "./rateLimit";

/** POST /api/games: por IP (si el proveedor falla, se rechaza). */
export async function guardCreate(request: Request, limiter?: RateLimiter): Promise<Response | null> {
  const ip = getClientIdentity(request.headers).key;
  return rateLimitResponse(await checkRateLimits([{ rule: rules().create, key: [ip] }], limiter));
}

/**
 * POST /api/games/[id]/advance: por IP + partida (cada partida tiene su propio cupo, así una
 * partida no agota la de otra) y por IP en total (si el proveedor falla, se deja pasar).
 */
export async function guardAdvance(request: Request, gameId: string, limiter?: RateLimiter): Promise<Response | null> {
  const ip = getClientIdentity(request.headers).key;
  return rateLimitResponse(
    await checkRateLimits(
      [
        { rule: rules().advanceGame, key: [ip, gameId] },
        { rule: rules().advanceIp, key: [ip] },
      ],
      limiter,
    ),
  );
}

/** Lecturas (GET /api/games/[id] y la página): límite suave por IP (si el proveedor falla, se deja pasar). */
export async function checkRead(headers: Headers, limiter?: RateLimiter): Promise<Decision> {
  const ip = getClientIdentity(headers).key;
  return checkRateLimits([{ rule: rules().read, key: [ip] }], limiter);
}

export async function guardRead(request: Request, limiter?: RateLimiter): Promise<Response | null> {
  return rateLimitResponse(await checkRead(request.headers, limiter));
}
