export interface Friend {
  id: number;
  username: string;
  avatar_url?: string;
  online?: boolean;
}

export interface FriendRequest {
  senderId: number;
  senderUsername: string;
  avatar_url?: string;
}
export interface FriendsResponse {
  friends: Friend[];
}

export interface FriendRequestsResponse {
  requests: FriendRequest[];
}