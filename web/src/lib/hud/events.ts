// Texto en español para los eventos del motor (registro del turno en el HUD).

import type { GameEvent, PlayerId } from "@/lib/engine";

export type PlayerNames = Readonly<Record<PlayerId, string>>;

const placeLabel = (n: number) => `${n}º`;

/**
 * Descripción breve de un evento, o `null` si no aporta información al espectador
 * (por ejemplo `turn_changed`, que ya se ve en el panel de jugadores).
 */
export function describeEvent(event: GameEvent, names: PlayerNames): string | null {
  const name = (id: PlayerId) => names[id] ?? id;

  switch (event.type) {
    case "dice_rolled":
      return `${name(event.playerId)} saca un ${event.value}`;
    case "no_moves":
      return `${name(event.playerId)} no puede mover con un ${event.value}`;
    case "piece_moved": {
      if (event.from.state === "base") return `${name(event.playerId)} saca una ficha de casa`;
      const how = event.withBonus ? `${event.distance} de bonus` : `${event.distance}`;
      return `${name(event.playerId)} avanza ${how}`;
    }
    case "piece_captured":
      return `${name(event.playerId)} captura una ficha de ${name(event.victimId)}`;
    case "piece_reached_goal":
      return `${name(event.playerId)} lleva una ficha a la meta`;
    case "bonus_granted":
      return `Bonus de +${event.amount} para ${name(event.playerId)}`;
    case "bonus_lost":
      return `${name(event.playerId)} pierde el bonus de +${event.amount}: no puede usarlo`;
    case "third_six_penalty":
      return event.pieceIndex === null
        ? `Tercer 6 de ${name(event.playerId)}: pierde el turno`
        : `Tercer 6 de ${name(event.playerId)}: su última ficha vuelve a casa`;
    case "roll_again":
      return `${name(event.playerId)} vuelve a tirar`;
    case "turn_timeout":
      return `${name(event.playerId)} agota su tiempo`;
    case "player_finished":
      return `${name(event.playerId)} termina en ${placeLabel(event.place)} lugar`;
    case "game_finished":
      return `Fin de la partida: gana ${name(event.winner)}`;
    case "turn_changed":
      return null;
  }
}
