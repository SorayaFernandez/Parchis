import { io } from "socket.io-client";
import { SOCKET_URL } from "../api/config";

export const socket = io(SOCKET_URL, {
  autoConnect: false,
});

export function connectSocket(token: string) {
  socket.auth = { token };

  if (!socket.connected) {
    socket.connect();
  }
}

export function disconnectSocket() {
  if (socket.connected) {
    socket.disconnect();
  }
}