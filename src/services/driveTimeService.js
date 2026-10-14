// Real driving minutes between two jobs, asked of the server.
//
// Thin on purpose: the arithmetic lives in durationService.js, the Google key
// lives in netlify/functions/drive-time.mjs, and this is the wire between
// them plus a cache so a scheduling screen can re-render freely.
//
// EVERY PATH THROUGH HERE CAN RETURN NULL AND NONE OF THEM THROWS. A null
// means "no routed answer", and travelGap() in durationService.js falls back
// to straight-line distance when it gets one. Booking a job is not allowed to
// fail because Google is down, a key expired, or the laptop is on a phone
// hotspot in somebody's driveway — which is exactly where this screen gets
// used.
//
// ---------------------------------------------------------------------------
// THREE BUGS LIVED HERE, AND THEY WERE ALL THE SAME BUG
// ---------------------------------------------------------------------------
//
// `Number(null)` is 0, and 0 is perfectly finite. durationService.js had that
// fault twice, its test suite caught it on the first run, and it was fixed
// there with a strict `num()` helper — while this file, which had no tests at
// all, kept all three of its own copies:
//
//   1. A job with `latitude: null` became {lat: 0, lng: 0} and was sent to
//      Google as a real place. Nought by nought is in the Gulf of Guinea.
//   2. A null in the server's reply became 0 minutes, which travelGap() then
//      floored to 15 and labelled `basis: "driven"`. An unroutable leg came
//      out reading "15 min drive" — a guess wearing a measurement's clothes,
//      which is worse than the guess on its own.
//   3. `Number(undefined)` is NaN and was handled, so a MISSING field worked
//      correctly while a NULL one did not. That is why it survived a read.
//
// The lesson is not about null. It is that this module talks to the network
// and therefore felt untestable, so it went untested, and the defect its
// neighbour had already been cured of walked straight back in.
// verify/drive-time.mjs exists now and injects a fake fetch.

const ENDPOINT = "/api/drive-time";

/**
 * Session-lifetime cache. Same reasoning as the function's own: the drive
 * between two fixed addresses does not change, so there is nothing to
 * invalidate. This one exists so that typing in the price field — which
 * re-renders the day preview on every keystroke — does not put a request on
 * the wire per character.
 */
const cache = new Map();

/**
 * Why the last request did not produce routed times, if it did not. One of:
 * "ok", "unconfigured", "not_deployed", "http", "offline", or null before
 * anything has been tried.
 *
 * A silent fallback is the correct BEHAVIOUR and a terrible DIAGNOSTIC. The
 * strips quietly showed straight-line distance whether the function was
 * missing, the key was unset, or Google had refused — three different
 * problems with three different fixes, and no way to tell them apart from
 * the screen. Now the reason is kept, and said out loud once.
 */
let status = null;
let announced = false;

export function driveTimeStatus() {
  return status;
}

function report(next, detail) {
  status = next;
  if (next === "ok" || announced) return;
  announced = true;
  // Once per session, not once per render.
  console.warn(
    `[drive-time] routed drive times are not being used (${next}). ` +
      `Falling back to straight-line distance. ${detail || ""}`
  );
}

/** A number, or null — where null, undefined and "" are all null. */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function point(place) {
  const lat = num(place?.latitude);
  const lng = num(place?.longitude);
  return lat === null || lng === null ? null : { lat, lng };
}

const keyFor = (a, b) =>
  `${round4(a.lat)},${round4(a.lng)}>${round4(b.lat)},${round4(b.lng)}`;

/**
 * @param {Array<[object, object]>} pairs  [from, to] places, each carrying
 *   {latitude, longitude}
 * @returns {Promise<Array<number|null>>} driving minutes, index-aligned with
 *   `pairs`. Null wherever there is no answer, for any reason at all.
 */
export async function fetchDriveMinutes(pairs) {
  const points = (pairs || []).map((pair) => {
    const from = point(pair?.[0]);
    const to = point(pair?.[1]);
    return from && to ? { from, to } : null;
  });

  const out = points.map((p) =>
    p && cache.has(keyFor(p.from, p.to)) ? cache.get(keyFor(p.from, p.to)) : null
  );

  // Only the legs with coordinates at both ends and no cache entry yet.
  const wanted = [];
  points.forEach((p, i) => {
    if (!p) return;
    if (cache.has(keyFor(p.from, p.to))) return;
    wanted.push({ i, leg: p });
  });

  if (wanted.length === 0) return out;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs: wanted.map((w) => w.leg) }),
    });
  } catch (err) {
    // Offline, or blocked. Not cached: the next attempt may well work, and
    // caching a hotspot dropout would poison the rest of the session.
    report("offline", String(err?.message || err));
    return out;
  }

  if (!res.ok) {
    // 404 is the one worth naming. It means the function is not deployed —
    // which is the state a repo is in after the code has been written and
    // before it has been pushed, and it looks exactly like "the key is
    // wrong" from the calendar.
    report(
      res.status === 404 ? "not_deployed" : "http",
      res.status === 404
        ? "POST /api/drive-time returned 404 — netlify/functions/drive-time.mjs is not in the deployed build."
        : `POST /api/drive-time returned ${res.status}.`
    );
    return out;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    report("http", "The response was not JSON.");
    return out;
  }

  // The server says so itself when GOOGLE_MAPS_SERVER_KEY is missing, and
  // throwing that away was how "I set the variable" and "the variable is not
  // reaching the function" became the same picture on screen.
  if (data?.source === "unconfigured") {
    report("unconfigured", data?.reason || "");
  } else {
    report("ok");
  }

  const minutes = Array.isArray(data?.minutes) ? data.minutes : [];

  wanted.forEach((w, n) => {
    const value = num(minutes[n]);
    // Cache the null as well: an address with no road to it will not grow
    // one, and re-asking on every keystroke is how a free tier stops being
    // free. A null here reaches travelGap() as null and comes back as a
    // straight-line estimate that SAYS it is one.
    cache.set(keyFor(w.leg.from, w.leg.to), value);
    out[w.i] = value;
  });

  return out;
}

/** One pair, for the common case. */
export async function fetchDriveMinutesBetween(from, to) {
  const [minutes] = await fetchDriveMinutes([[from, to]]);
  return minutes ?? null;
}

/** Testing seam. Not used by the app. */
export function __resetDriveTimeCache() {
  cache.clear();
  status = null;
  announced = false;
}
