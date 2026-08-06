import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

// This context lets any component know who's logged in (or if nobody is),
// without passing props down through every level.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // On load, check if there's already an active session (e.g. page refresh).
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // Then listen for any future login / logout and update accordingly.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    // Clean up the listener when the app unmounts.
    return () => subscription.unsubscribe();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    signOut: () => supabase.auth.signOut(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Handy hook so components can just call useAuth() to get the current user.
export function useAuth() {
  return useContext(AuthContext);
}