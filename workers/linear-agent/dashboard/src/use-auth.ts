import { useState, useEffect, useCallback, createContext, useContext } from "react";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  logout: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export { AuthContext };

export function useAuthProvider(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/dashboard/api/me", { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error("unauthenticated");
        return res.json() as Promise<AuthUser>;
      })
      .then((data) => {
        if (!cancelled) setUser(data);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    await fetch("/dashboard/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    window.location.href = "/dashboard/login";
  }, []);

  return { user, loading, logout };
}
