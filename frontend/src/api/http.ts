import { API_URL } from "./config";

export async function http<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {

  const token = sessionStorage.getItem("token");
  if (!token)
  {
    throw new Error("No authentication token");
  }

  const res = await fetch(
    `${API_URL}${endpoint}`,
    {
      ...options,

      headers: {
        "Content-Type": "application/json",

        ...(token
          ? {
              Authorization:
                `Bearer ${token}`,
            }
          : {}),

        ...options.headers,
      },
    }
  );

  let data;

  try
  {
    data = await res.json();

  }
  catch
  {
    throw new Error("Invalid server response");
  }
  if (!res.ok)
  {
    throw new Error(data.error || "HTTP Error");
  }
  return data;
}
