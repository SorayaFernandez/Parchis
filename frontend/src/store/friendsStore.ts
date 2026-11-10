import { create } from "zustand";

export interface Friend {
  id: number;
  username: string;
  avatar_url?: string;
  online?: boolean;
}

interface FriendsStore {
  friends: Friend[];

  setFriends: (
    friends: Friend[]
  ) => void;

  updateOnlineStatus: (
    userId: number,
    online: boolean
  ) => void;
}

export const useFriendsStore =
  create<FriendsStore>((set) => ({
    friends: [],

    setFriends: (friends) =>
      set({ friends }),

    updateOnlineStatus: (
      userId,
      online
    ) =>
      set((state) => ({
        friends: state.friends.map(
          (friend) =>
            friend.id === userId
              ? {
                  ...friend,
                  online,
                }
              : friend
        ),
      })),
  }));