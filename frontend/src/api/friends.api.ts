import { http } from "./http";
import type { Friend, FriendRequest } from "../types/friend";

export function getFriends() {
  return http<{
    friends: Friend[];
  }>("/friends");
}

export function getPendingRequests() {
  return http<{
    requests: FriendRequest[];
  }>("/friends/requests");
}

export function acceptFriendRequest(requestId: number) {
  return http<void>(`/friends/accept/${requestId}`, {
    method: "POST",
  });
}

export function sendFriendRequest(userId: number) {
  return http<void>(`/friends/request/${userId}`, {
    method: "POST",
  });
}

export function removeFriend(friendId: number) {
  return http<void>(`/friends/${friendId}`, {
    method: "DELETE",
  });
}