// GET /api/games/[id]/messages — chat de una partida.
// Sin `after`: los últimos mensajes (carga inicial). Con `?after=<id>`: los posteriores a ese id, en
// orden y por páginas (`hasMore`), para recuperar lo perdido tras una desconexión.
// `pending`: quedan versiones por procesar; en ese caso también pone en marcha el procesador.

import { z } from "zod";
import { CHAT_LIMITS } from "@/lib/chat/config";
import type { ChatPage } from "@/lib/chat/schemas";
import { scheduleDrain } from "@/lib/chat/schedule";
import { ChatStoreError, getChatStore } from "@/lib/chat/store";
import { NO_STORE, errorResponse, handleRouteError } from "@/lib/http/responses";
import { guardRead } from "@/lib/security/guards";

const AfterSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export async function GET(request: Request, ctx: RouteContext<"/api/games/[id]/messages">) {
  const { id } = await ctx.params;

  const limited = await guardRead(request);
  if (limited) return limited;

  if (!z.uuid().safeParse(id).success) return errorResponse(404, "not_found", "La partida no existe.");
  const raw = new URL(request.url).searchParams.get("after");
  const after = raw === null ? null : AfterSchema.safeParse(raw.trim() === "" ? "x" : raw);
  if (after && !after.success) return errorResponse(400, "invalid_query", "`after` debe ser un entero ≥ 0.");

  try {
    const store = getChatStore();
    const [messages, pending] = await Promise.all([
      after === null ? store.latest(id, CHAT_LIMITS.initialMessages) : store.after(id, after.data, CHAT_LIMITS.pageSize),
      store.pending(id),
    ]);
    // Recuperación: si quedan versiones pendientes (p. ej., un procesador anterior se interrumpió
    // y ya no llegan avances porque la partida terminó), se procesan tras responder.
    if (pending) scheduleDrain(id);
    const page: ChatPage = {
      messages,
      hasMore: after !== null && messages.length === CHAT_LIMITS.pageSize,
      pending,
    };
    return Response.json(page, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ChatStoreError) {
      console.error(`[GET /api/games/[id]/messages] ${error.kind}${error.code ? ` (${error.code})` : ""}`);
      return error.kind === "database"
        ? errorResponse(503, "chat_unavailable", "El chat no está disponible ahora mismo.")
        : errorResponse(500, "internal_error", "El chat guardado no se puede leer.");
    }
    return handleRouteError("GET /api/games/[id]/messages", error);
  }
}
