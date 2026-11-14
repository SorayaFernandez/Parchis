import type { Metadata } from "next";
import Link from "next/link";
import { BoardDemo } from "@/components/board/BoardDemo";
import { createDemoMatch } from "@/lib/board/demo";

export const metadata: Metadata = {
  title: "Demostración · Parchís IA",
};

/**
 * Partida de demostración: la misma pantalla que /partida/[id], jugada en el navegador con el motor, la IA
 * y el chat local reales, sin Supabase ni servicios externos. La partida inicial (semilla fija) se calcula
 * al prerenderizar, así que la página es estática y el HTML ya la trae.
 */
export default async function BoardPage() {
  const initial = await createDemoMatch();
  return (
    // `dark`: el tablero es oscuro. Misma estructura que /partida/[id] (alto de ventana desde xl).
    <main className="dark flex min-h-dvh flex-1 flex-col items-center gap-4 bg-[#020617] px-4 py-6 text-slate-100 xl:h-dvh xl:min-h-0 xl:flex-none xl:gap-3 xl:overflow-hidden xl:py-3">
      <header className="flex w-full max-w-6xl shrink-0 items-center justify-between gap-4 xl:max-w-[112rem]">
        <h1 className="text-xl font-bold tracking-tight">Demostración</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-100">
          Volver
        </Link>
      </header>
      <BoardDemo initial={initial} />
    </main>
  );
}
