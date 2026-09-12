// Which leads the two lead pages are showing: yours, or everyone's.
//
// Split out from ScopeToggle.jsx because a file that exports a component
// must export nothing else — mixing a constant in breaks React Fast
// Refresh, which is what react-refresh/only-export-components warns about.
// Same reason navViews.js and auth-context.js live apart from their
// components.
import { remember, recall } from "./viewMemory";

export const SCOPES = ["mine", "all"];
const STORAGE_KEY = "leadScope";

// Read the remembered choice.
//
// Exported so a page can seed its own state before the first fetch rather
// than defaulting and then correcting — otherwise the board renders the
// whole team's leads for a frame before narrowing to yours.
export function initialScope() {
  return recall(STORAGE_KEY, "mine", SCOPES);
}

export function rememberScope(scope) {
  remember(STORAGE_KEY, scope);
}
