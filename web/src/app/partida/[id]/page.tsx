import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { GameScreen } from "@/components/game/GameScreen";
import { GameLoading } from "@/components/game/GameStatus";
import { loadChatMessages } from "@/lib/chat/load";
import { loadGame } from "@/lib/game/load";
import { checkRead } from "@/lib/security/guards";

export const metadata: Metadata = {
  title: "Partida · Parchís IA",
};

/**
 * Lee la partida en el servidor (repositorio + cliente de servidor, validada con Zod).
 * Es dinámico (params y BD), así que va dentro de <Suspense>: la cabecera y el esqueleto
 * forman parte del shell estático (Partial Prerender) y esto se envía en streaming.
 */
async function GameLoader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Mismo límite suave de lectura que GET /api/games/[id] (la página también lee la BD).
  const decision = await checkRead(await headers());
  if (decision.kind === "limited") {
    return (
      <GameScreen
        result={{ kind: "error", message: `Demasiadas peticiones. Espera ${decision.retryAfterSec} s e inténtalo de nuevo.` }}
      />
    );
  }
  // Partida y últimos mensajes del chat en paralelo; si el chat falla, la partida se muestra igual.
  const [result, chat] = await Promise.all([loadGame(id), loadChatMessages(id)]);
  return <GameScreen result={result} messages={chat.messages} chatPending={chat.pending} />;
}

/** Partida en modo espectador: carga inicial en el servidor y, después, en directo (LiveGame). */
export default function GamePage({ params }: PageProps<"/partida/[id]">) {
  return (
    // `dark`: el tablero es oscuro, así que los componentes de shadcn usan su tema oscuro.
    <main className="dark flex min-h-dvh flex-1 flex-col items-center gap-4 bg-[#020617] px-4 py-6 text-slate-100">
      <header className="flex w-full max-w-6xl items-center justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight">Partida</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-100">
          Volver
        </Link>
      </header>

      <Suspense fallback={<GameLoading />}>
        <GameLoader params={params} />
      </Suspense>
    </main>
  );
}
