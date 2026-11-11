"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

/** Vuelve a ejecutar los Server Components de la ruta (y con ellos la carga de la partida). */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button onClick={() => startTransition(() => router.refresh())} disabled={pending}>
      {pending ? "Reintentando…" : "Reintentar"}
    </Button>
  );
}
