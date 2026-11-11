"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { NewGameController, type NewGameState } from "@/lib/home/newGame";

/** Botón "Nueva partida": crea una partida real con los cuatro personajes y abre /partida/[id]. */
export function NewGameButton() {
  const router = useRouter();
  const [controller] = useState(
    () => new NewGameController({ fetch: (...args) => fetch(...args), navigate: (href) => router.push(href) }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Al salir de la portada (navegación del App Router: la ruta se oculta con <Activity> y conserva su
  // estado) se limpian los efectos: el botón vuelve a reposo para cuando se regrese.
  useEffect(() => () => controller.reset(), [controller]);
  return <NewGameButtonView state={state} onCreate={() => void controller.create()} />;
}

/** Presentación (sin hooks): botón, estado de carga y error con reintento. */
export function NewGameButtonView({ state, onCreate }: { state: NewGameState; onCreate: () => void }) {
  const creating = state.kind === "creating";
  return (
    <div className="flex flex-col items-center gap-3">
      <Button size="lg" className="h-11 px-6 text-base" onClick={onCreate} disabled={creating} aria-busy={creating}>
        {creating ? "Creando partida…" : state.kind === "error" ? "Reintentar" : "Nueva partida"}
      </Button>
      {/* Región siempre presente para que los lectores de pantalla anuncien el progreso y los errores. */}
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {creating ? "Preparando el tablero y los cuatro personajes…" : ""}
      </p>
      {state.kind === "error" && (
        <p role="alert" className="max-w-sm text-sm text-red-500 dark:text-red-400">
          {state.message}
        </p>
      )}
    </div>
  );
}
