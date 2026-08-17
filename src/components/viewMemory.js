// Remembers which view you were last on in each section, so tapping a nav
// tab returns you where you left off instead of always resetting to the
// section's first view.
//
// localStorage rather than component state on purpose: it has to survive a
// full page close, not just navigation. Wrapped in try/catch because
// storage throws in private-browsing modes on some browsers, and a nav
// convenience must never be able to break the app.

const KEY = "crmLastView";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function rememberView(section, path) {
  if (!section || !path) return;
  try {
    const all = readAll();
    if (all[section] === path) return; // no pointless writes
    all[section] = path;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable — the app still works, it just won't remember.
  }
}

// `allowed` guards against a stale path from an older build sending you to
// a route that no longer exists.
export function lastViewFor(section, fallback, allowed) {
  const saved = readAll()[section];
  if (!saved) return fallback;
  if (allowed && !allowed.includes(saved)) return fallback;
  return saved;
}

// Which of `views` the current pathname is showing. Exact match wins;
// otherwise the longest prefix, so /leads/all doesn't resolve to /leads.
export function matchView(views, pathname) {
  const exact = views.find((v) => v.to === pathname);
  if (exact) return exact;

  return (
    views
      .filter((v) => !v.end && pathname.startsWith(v.to + "/"))
      .sort((a, b) => b.to.length - a.to.length)[0] || null
  );
}
