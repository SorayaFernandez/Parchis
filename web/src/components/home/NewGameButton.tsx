"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NewGameController, type NewGameState } from "@/lib/home/newGame";

/** Clases opcionales (solo presentación): el contenedor y el propio botón. */
export interface NewGameButtonStyle {
  className?: string;
  buttonClassName?: string;
}

/** Botón "Nueva partida": crea una partida real con los cuatro personajes y abre /partida/[id]. */
export function NewGameButton(style: NewGameButtonStyle = {}) {
  const router = useRouter();
  const [controller] = useState(
    () => new NewGameController({ fetch: (...args) => fetch(...args), navigate: (href) => router.push(href) }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Al salir de la portada (navegación del App Router: la ruta se oculta con <Activity> y conserva su
  // estado) se limpian los efectos: el botón vuelve a reposo para cuando se regrese.
  useEffect(() => () => controller.reset(), [controller]);
  return <NewGameButtonView state={state} onCreate={() => void controller.create()} {...style} />;
}

/** Presentación (sin hooks): botón, estado de carga y error con reintento. */
export function NewGameButtonView({
  state,
  onCreate,
  className,
  buttonClassName,
}: { state: NewGameState; onCreate: () => void } & NewGameButtonStyle) {
  const creating = state.kind === "creating";
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <Button size="lg" className={cn("h-11 px-6 text-base", buttonClassName)} onClick={onCreate} disabled={creating} aria-busy={creating}>
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
