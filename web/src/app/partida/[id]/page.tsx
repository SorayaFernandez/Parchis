import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
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
  const requestHeaders = await headers();
  // Con cacheComponents, `headers()` también se resuelve al prerenderizar el App Shell de la ruta.
  // `connection()` deja lo que sigue (límite de lectura, BD y el Date.now() de Upstash) solo para
  // peticiones reales: sin esto, Next.js avisaba de Date.now() durante el prerenderizado.
  await connection();
  // Mismo límite suave de lectura que GET /api/games/[id] (la página también lee la BD).
  const decision = await checkRead(requestHeaders);
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
    // Desde xl (≥ 1280 px), la pantalla ocupa exactamente el alto de la ventana, sin scroll de página:
    // la rejilla de GameView (ver `components/game/layout.ts`) se reparte el resto.
    <main className="dark flex min-h-dvh flex-1 flex-col items-center gap-4 bg-[#020617] px-4 py-6 text-slate-100 xl:h-dvh xl:min-h-0 xl:flex-none xl:gap-3 xl:overflow-hidden xl:py-3">
      <header className="flex w-full max-w-6xl shrink-0 items-center justify-between gap-4 xl:max-w-[112rem]">
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
