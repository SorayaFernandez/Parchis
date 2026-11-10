import { create } from "zustand";
import type { Game } from "../types/game";

type GameStore = {
	game: Game | null;

	showLastPlayerPopup: boolean;

	setGame: (
		game: Game
	) => void;

	setShowLastPlayerPopup: (
		value: boolean
	) => void;

	clear: () => void;
};

export const useGameStore = create<GameStore>((set) => ({
  game: null,

  showLastPlayerPopup: false,

  setGame: (game) =>
    set({ game }),

  setShowLastPlayerPopup: (value) =>
    set({
      showLastPlayerPopup: value,
    }),

  clear: () =>
    set({
      game: null,
      showLastPlayerPopup: false,
    }),
}));