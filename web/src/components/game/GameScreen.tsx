import type { LoadGameResult } from "@/lib/game/api";
import { GameError } from "./GameStatus";
import { LiveGame } from "./LiveGame";

/** Lo que se muestra para cada resultado de `loadGame` (sin hooks: se renderiza en el servidor). */
export function GameScreen({ result }: { result: LoadGameResult }) {
  switch (result.kind) {
    case "not_found":
      return (
        <GameError
          title="Partida no encontrada"
          message="No existe ninguna partida con este identificador. Comprueba el enlace."
        />
      );
    case "error":
      return <GameError title="No se ha podido cargar la partida" message={result.message} retryable />;
    case "ok":
      // En directo (avance + Realtime). Si ya terminó, LiveGame no conecta nada.
      return <LiveGame initial={result.game} />;
  }
}
