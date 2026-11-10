import { create } from "zustand";
import { socket } from "../socket/socket";

type SocketStore = {
  connected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
};

export const useSocketStore = create<SocketStore>((set) => ({
  connected: false,

  connect: (token) => {
    socket.auth = { token };
    socket.connect();
    set({ connected: true });
  },

  disconnect: () => {
    socket.disconnect();
    set({ connected: false });
  },
}));