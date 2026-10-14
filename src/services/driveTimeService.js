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

const ENDPOINT = "/api/drive-time";

/**
 * Session-lifetime cache. Same reasoning as the function's own: the drive
 * between two fixed addresses does not change, so there is nothing to
 * invalidate. This one exists so that typing in the price field — which
 * re-renders the day preview on every keystroke — does not put a request on
 * the wire per character.
 */
const cache = new Map();

const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

function point(place) {
  const lat = Number(place?.latitude);
  const lng = Number(place?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
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
  const points = (pairs || []).map(([a, b]) => {
    const from = point(a);
    const to = point(b);
    return from && to ? { from, to } : null;
  });

  const out = points.map((p) => (p && cache.has(keyFor(p.from, p.to))
    ? cache.get(keyFor(p.from, p.to))
    : null));

  // Only the ones we have neither a cache entry nor missing coordinates for.
  const wanted = [];
  points.forEach((p, i) => {
    if (!p) return;
    if (cache.has(keyFor(p.from, p.to))) return;
    wanted.push({ i, leg: p });
  });

  if (wanted.length === 0) return out;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs: wanted.map((w) => w.leg) }),
    });
    if (!res.ok) return out;

    const data = await res.json();
    const minutes = Array.isArray(data?.minutes) ? data.minutes : [];

    wanted.forEach((w, n) => {
      const m = Number(minutes[n]);
      const value = Number.isFinite(m) ? m : null;
      // Cache the null as well. An unconfigured key or an address with no
      // road to it will give the same answer next keystroke, and asking again
      // is how a free tier stops being free.
      cache.set(keyFor(w.leg.from, w.leg.to), value);
      out[w.i] = value;
    });
  } catch {
    // Offline, blocked, or the function is not deployed yet. The caller's
    // fallback is the whole point; there is nothing to report here.
    return out;
  }

  return out;
}

/** One pair, for the common case. */
export async function fetchDriveMinutesBetween(from, to) {
  const [minutes] = await fetchDriveMinutes([[from, to]]);
  return minutes ?? null;
}
