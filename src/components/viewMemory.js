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

/* ---------------------------------------------------------------------
   Remembering small bits of screen state
   ---------------------------------------------------------------------
   Same storage, same try/catch discipline as the section memory above,
   for values that aren't a route: which calendar view you were on, which
   day you were looking at. */

const STATE_KEY = "crmViewState";

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeState(next) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the app works, it just won't remember.
  }
}

// A plain preference with no shelf life. `allowed` guards against a value
// left behind by an older build.
export function remember(key, value) {
  const all = readState();
  if (all[key] === value) return; // no pointless writes
  writeState({ ...all, [key]: value });
}

export function recall(key, fallback, allowed) {
  const v = readState()[key];
  if (v === undefined || v === null) return fallback;
  if (allowed && !allowed.includes(v)) return fallback;
  return v;
}

/* A remembered DATE is different from a remembered preference, because it
   goes stale in a way a preference never does.
   
   Looking at tomorrow's round, tapping into a customer and coming back
   should return you to tomorrow — that's the whole point. But opening the
   app next week and being shown a day from last week is worse than
   useless: every job on screen would be the wrong one, and "Mark
   completed" would be sitting under it.
   
   So a date is only honoured while it was saved on the same calendar day
   you're asking on. Beyond that it quietly reverts to today. */

function dayStamp(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function rememberDay(key, date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
  const all = readState();
  writeState({
    ...all,
    [key]: { at: date.toISOString(), savedOn: dayStamp(new Date()) },
  });
}

export function recallDay(key) {
  const entry = readState()[key];
  if (!entry?.at || !entry?.savedOn) return null;
  if (entry.savedOn !== dayStamp(new Date())) return null; // stale
  const d = new Date(entry.at);
  return Number.isNaN(d.getTime()) ? null : d;
}
