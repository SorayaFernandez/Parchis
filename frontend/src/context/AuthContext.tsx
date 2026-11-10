import {
  createContext,
  useContext,
  useState,
  useEffect,
} from "react";

import { getMe } from "../api/user.api";

import {
  connectSocket,
  disconnectSocket,
} from "../socket/socket";

type User = {
  id: number;
  username: string;
  email: string;
};

type AuthContextType = {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
};

const AuthContext =
  createContext<AuthContextType | null>(null);

export function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [token, setToken] =
    useState<string | null>(
      sessionStorage.getItem("token")
    );

  const [user, setUser] =
    useState<User | null>(null);

  useEffect(() => {
    const loadUser = async () => {
      if (!token) return;

      try {
        const me = await getMe();
        setUser(me);

        connectSocket(token);
      } catch (err) {
        logout();
      }
    };

    loadUser();
  }, [token]);

  const login = (
    newToken: string,
    user: User
  ) => {
    sessionStorage.setItem(
      "token",
      newToken
    );

    setToken(newToken);
    setUser(user);
  };

  const logout = () => {
    sessionStorage.removeItem("token");

    disconnectSocket();

    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);

  if (!ctx)
    throw new Error(
      "useAuth must be used inside AuthProvider"
    );

  return ctx;
};
