import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GAME_AREA, GAME_BOARD, GAME_GRID } from "./layout";
import { RetryButton } from "./RetryButton";

/** Esqueleto mientras se carga la partida (misma disposición que GameView). */
export function GameLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={GAME_GRID}
    >
      <span className="sr-only">Cargando partida…</span>
      <div className={`${GAME_AREA.banner} h-11 rounded-2xl bg-white/5 motion-safe:animate-pulse`} aria-hidden="true" />
      <div className={GAME_AREA.board} aria-hidden="true">
        <div className={`${GAME_BOARD} aspect-square rounded-3xl bg-white/5 motion-safe:animate-pulse`} />
      </div>
      <div className={GAME_AREA.right} aria-hidden="true">
        <div className="h-28 shrink-0 rounded-2xl bg-white/5 motion-safe:animate-pulse" />
        <div className="h-72 rounded-2xl bg-white/5 motion-safe:animate-pulse xl:h-auto xl:flex-1" />
      </div>
      <div className={GAME_AREA.left} aria-hidden="true">
        <div className="h-40 rounded-2xl bg-white/5 motion-safe:animate-pulse xl:h-auto xl:flex-1" />
      </div>
    </div>
  );
}

interface GameErrorProps {
  title: string;
  message: string;
  /** Muestra el botón de reintentar (vuelve a cargar la partida en el servidor). */
  retryable?: boolean;
}

/** Mensaje de error (partida inexistente o no recuperable). Sirve en servidor y cliente. */
export function GameError({ title, message, retryable = false }: GameErrorProps) {
  return (
    <div role="alert" className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-slate-300">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {retryable && <RetryButton />}
        {/* Enlace con aspecto de botón: Base UI necesita nativeButton={false} al renderizar un <a>. */}
        <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
          Volver al inicio
        </Button>
      </div>
    </div>
  );
}
