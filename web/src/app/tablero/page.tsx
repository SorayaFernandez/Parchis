import type { Metadata } from "next";
import Link from "next/link";
import { BoardDemo } from "@/components/board/BoardDemo";

export const metadata: Metadata = {
  title: "Tablero · Parchís IA",
};

export default function BoardPage() {
  return (
    // `dark`: el tablero es oscuro, así que los componentes de shadcn usan su tema oscuro.
    <main className="dark flex min-h-dvh flex-1 flex-col items-center gap-4 bg-[#020617] px-4 py-6 text-slate-100">
      <header className="flex w-full max-w-6xl items-center justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight">Tablero (demo)</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-100">
          Volver
        </Link>
      </header>
      <BoardDemo />
    </main>
  );
}
