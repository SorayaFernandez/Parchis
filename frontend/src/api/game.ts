import { API_URL } from "./config";

function getToken() {
  return sessionStorage.getItem("token");
}

export async function createGame() {
  const token = getToken();

  if (!token) {
    throw new Error("No authentication token");
  }

  const res = await fetch(`${API_URL}/games`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return res.json();
}

export async function getGame(gameId: string) {
  const token = getToken();

  if (!token) {
    throw new Error("No authentication token");
  }

  const res = await fetch(`${API_URL}/games/${gameId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return res.json();
}

export async function joinGame(gameId: string) {
  const token = getToken();

  if (!token) {
    throw new Error("No authentication token");
  }

  const res = await fetch(`${API_URL}/games/${gameId}/join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return res.json();
}

export async function rollDice(gameId: string) {
  const token = getToken();

  if (!token) {
    throw new Error("No authentication token");
  }

  const res = await fetch(`${API_URL}/games/${gameId}/roll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return res.json();
}

export async function movePiece(gameId: string, pieceIndex: number) {
  const token = getToken();

  if (!token) {
    throw new Error("No authentication token");
  }

  const res = await fetch(
    `${API_URL}/games/${gameId}/move`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pieceIndex }),
    }
  );

  return res.json();
}