import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null); // { full_name, role, ... }
  const [loading, setLoading] = useState(true);
  // True from the moment a password-reset link is opened until a new
  // password is actually set.
  //
  // A recovery link is a real session, so without this the app treats it
  // as an ordinary sign-in and drops the person on the leads board —
  // logged in, but with no way to reach the page that sets a password, and
  // still using whatever password they were trying to replace. Which is
  // exactly what happened.
  //
  // Deliberately in memory only. It should not survive a refresh: being
  // permanently trapped on the reset page is a worse failure than needing
  // to request a second link.
  const [recovery, setRecovery] = useState(false);

  // Fetch the profile row for a given user id.
  async function loadProfile(userId) {
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) {
      console.error("Couldn't load profile:", error);
      setProfile(null);
    } else {
      setProfile(data);
    }
  }

  useEffect(() => {
    // On load, check for an existing session and load its profile.
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session?.user?.id);
      setLoading(false);
    });

    // React to future logins/logouts.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") setRecovery(false);
      setSession(newSession);
      await loadProfile(newSession?.user?.id);
    });

    return () => subscription.unsubscribe();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    isAdmin: profile?.role === "admin",
    isTech: profile?.role === "tech",
    loading,
    recovery,
    // Called once the new password is saved, which is the only thing that
    // ends a recovery.
    endRecovery: () => setRecovery(false),
    signOut: () => supabase.auth.signOut(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
