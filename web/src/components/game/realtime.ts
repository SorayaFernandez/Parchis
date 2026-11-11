// Suscripción de Realtime a los cambios de una partida (navegador, clave publicable).
// RLS solo permite leer, así que el navegador no puede escribir nada por este canal.

import type { RealtimeHandlers, RealtimeStatus } from "@/lib/game/liveController";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export function subscribeToGame(gameId: string, { onRow, onStatus }: RealtimeHandlers): () => void {
  const supabase = getBrowserSupabase();
  const channel = supabase
    .channel(`game:${gameId}`, {
      // SUBSCRIBED solo cuando postgres_changes ya está activo: así la resincronización que hace el
      // controlador al suscribirse no deja huecos entre ella y el primer evento.
      config: { postgres_changes_options: { wait: true } },
    })
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
      (payload) => onRow(payload.new),
    )
    .subscribe((status) => onStatus(status as RealtimeStatus));

  return () => {
    void supabase.removeChannel(channel);
  };
}
