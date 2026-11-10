import { API_URL } from "./config";

function getAuthHeader(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function safeFetch(res: Response) {
  const text = await res.text();

  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!res.ok) {
    throw new Error(data?.error || `API Error ${res.status}`);
  }

  return data;
}

export async function createGame(token: string) {
  const res = await fetch(`${API_URL}/games`, {
    method: "POST",
    headers: getAuthHeader(token),
  });

  return safeFetch(res);
}

export async function getGame(token: string, id: string) {
  const res = await fetch(`${API_URL}/games/${id}`, {
    headers: getAuthHeader(token),
  });

  return safeFetch(res);
}

export async function joinGame(token: string, id: string) {
  const res = await fetch(`${API_URL}/games/${id}/join`, {
    method: "POST",
    headers: getAuthHeader(token),
  });

  return safeFetch(res);
}

export async function rollDice(token: string, id: string) {
  const res = await fetch(`${API_URL}/games/${id}/roll`, {
    method: "POST",
    headers: getAuthHeader(token),
  });

  return safeFetch(res);
}

export async function movePiece(
  token: string,
  id: string,
  pieceIndex: number
) {
  const res = await fetch(`${API_URL}/games/${id}/move`, {
    method: "POST",
    headers: getAuthHeader(token),
    body: JSON.stringify({ pieceIndex }),
  });

  return safeFetch(res);
}

export async function moveBonusPiece(
  token: string,
  id: string,
  pieceIndex: number
) {
  const res = await fetch(
    `${API_URL}/games/${id}/bonus`,
    {
      method: "POST",
      headers: getAuthHeader(token),
      body: JSON.stringify({ pieceIndex }),
    }
  );

  return safeFetch(res);
}