import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuthResponse, Me } from "@/types";

interface AuthState {
  access: string | null;
  refresh: string | null;
  user: Me | null;
  signIn: (data: AuthResponse) => void;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: Me) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      access: null,
      refresh: null,
      user: null,
      signIn: ({ access, refresh, user }) => set({ access, refresh, user }),
      setTokens: (access, refresh) => set({ access, refresh }),
      setUser: (user) => set({ user }),
      clear: () => set({ access: null, refresh: null, user: null }),
    }),
    { name: "flowboard-auth" },
  ),
);
