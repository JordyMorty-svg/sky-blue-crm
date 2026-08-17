import { useContext } from "react";
import { AuthContext } from "./auth-context";

// Lives apart from AuthContext.jsx so that file exports only components.
// Mixing a hook in with a component breaks React Fast Refresh, which is
// what react-refresh/only-export-components is warning about.
export function useAuth() {
  return useContext(AuthContext);
}
