import { http } from "./http";
import type { User } from "../types/user";

export function getMe() {
  return http<User>("/users/me");
}

export function updateProfile(
  username: string,
  avatar_url: string
) {
  return http<User>("/users/me", {
    method: "PUT",
    body: JSON.stringify({
      username,
      avatar_url,
    }),
  });
}

export function searchUsers(query: string) {
  return http<{
    users: {
        id: number;
        username: string;
        avatar_url?: string;
        online?: boolean;

        friendship_status:
            | "none"
            | "pending"
            | "received"
            | "accepted";
    }[];
  }>(`/users/search?q=${encodeURIComponent(query)}`);
}

export function getUserById(id: number | string) {
  return http<User>(`/users/${id}`);
}