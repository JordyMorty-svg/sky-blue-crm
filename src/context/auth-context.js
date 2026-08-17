import { createContext } from "react";

// The context object lives alone so that AuthContext.jsx exports only a
// component and useAuth.js exports only a hook. Mixing kinds in one file
// breaks React Fast Refresh, which is what react-refresh warns about.
// Named with a hyphen rather than a case variation because Windows
// filesystems are case-insensitive and would collide with AuthContext.jsx.
export const AuthContext = createContext(null);
