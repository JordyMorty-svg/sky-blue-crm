// netlify/functions/drive-time.mjs
//
// How many minutes of road sit between two jobs.
//
//   POST /api/drive-time   { legs: [{ from: {lat,lng}, to: {lat,lng} }, ...] }
//   ->                     { minutes: [12, 27, null], source: "routes" }
//
// A null in the array means "we could not find out" — never a guess. The
// caller already has a straight-line fallback (travelGap() in
// src/services/durationService.js) and a null is how it is told to use it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A FUNCTION AND NOT A FETCH FROM THE BROWSER
// ---------------------------------------------------------------------------
//
// The CRM already loads Google Maps in the page (APIProvider in main.jsx) with
// VITE_GOOGLE_MAPS_API_KEY, so calling a distance service client-side looks
// like the shorter road. It is the wrong one. A VITE_ variable is compiled
// into the bundle and is readable by anyone who opens the page, so that key
// can only ever be referrer-restricted — and referrer restrictions do not
// protect a billable routing call the way they protect a map tile. The key
// that can compute routes stays on the server.
//
// ---------------------------------------------------------------------------
// WHY THE ROUTES API AND NOT THE DISTANCE MATRIX API
// ---------------------------------------------------------------------------
//
// Distance Matrix is the obvious name and it is the wrong choice as of this
// month. Google's own page: "As of October 2026, Distance Matrix API (Legacy)
// can no longer be enabled for new Google Cloud projects." Existing projects
// keep working, but building something new on a legacy SKU that cannot be
// turned on is building a thing that cannot be redeployed.
//
// Routes API → computeRouteMatrix is the replacement. Essentials tier is
// 10,000 free calls a month and $5 per 1,000 after that. Sky Blue schedules
// on the order of 120 jobs a month, at one or two legs each, so this is
// inside the free allowance by two orders of magnitude.
//
// TRAFFIC_UNAWARE on purpose, and it is both the cheaper and the more correct
// choice. Jobs are booked days ahead, so "traffic right now" is noise about a
// Tuesday that has not happened. Traffic-aware routing is also a Pro-tier SKU.
// The 15-minute buffer in durationService.js is what absorbs traffic; this
// call supplies the distance part, which is the part that actually varies
// between a job across town and a job in Albany.
//
// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
//
//   GOOGLE_MAPS_SERVER_KEY   a server-side key with the Routes API enabled.
//                            GOOGLE_MAPS_API_KEY is accepted as a fallback
//                            name, matching how the rest of the repo spells
//                            Supabase's key two ways.
//
// UNSET IS A SUPPORTED STATE, NOT AN ERROR. With no key this returns nulls and
// a reason, 200, and the scheduling screen quietly uses straight-line
// distance. Scheduling is not allowed to break because a billing account
// lapsed.

const MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/** At most this many legs per request. Nothing legitimate needs more. */
const MAX_LEGS = 8;

const apiKey = () =>
  process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY;

/**
 * Cache in module scope, which on Netlify survives for as long as the
 * instance stays warm. Drive time between two fixed points does not change,
 * so there is nothing to invalidate and no TTL to get wrong — a cold start
 * simply pays for the call again.
 *
 * Four decimal places is about 11 metres, which is finer than the difference
 * between two houses and coarser than GPS jitter on the same one.
 */
const cache = new Map();
const hasCoords = (p) =>
  Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng));
const hasAddress = (p) => String(p?.address ?? "").trim() !== "";
const usable = (p) => hasCoords(p) || hasAddress(p);

const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

/**
 * ONE SIDE OF A CACHE KEY, and it has to understand addresses.
 *
 * This read `${round4(leg.from.lat)},${round4(leg.from.lng)}` when every
 * waypoint was coordinates. Once an address became a waypoint, `lat` is
 * undefined on those legs, `round4(undefined)` is NaN, and EVERY
 * address-based leg in the process collided on the single key
 * "NaN,NaN>NaN,NaN".
 *
 * Nulls are cached on purpose — a pair with no route will not grow one, and
 * re-asking every render is how a free tier stops being free. Put those two
 * together and the first address leg that failed to route handed its null to
 * every other address leg on the instance. Which is precisely what it did:
 * a customer whose address had just been corrected still reported "no route
 * came back", because nothing was being asked on their behalf at all.
 *
 * The identical fix had already been made in driveTimeService.js an hour
 * earlier. One copy got it; its mirror image did not — the same shape of
 * mistake as `Number(null)`, and for the same reason: this file had no test.
 */
const sideKey = (p) =>
  hasCoords(p) ? `${round4(p.lat)},${round4(p.lng)}` : `@${String(p.address).trim()}`;

const keyFor = (leg) => `${sideKey(leg.from)}>${sideKey(leg.to)}`;

function validLeg(leg) {
  return usable(leg?.from) && usable(leg?.to);
}

/**
 * A waypoint is either coordinates or an address.
 *
 * NOTE THE SHAPE: `address` sits directly on the waypoint, a sibling of
 * `placeId`, NOT nested under `location` the way `latLng` is. Getting that
 * wrong produces a 400 that reads like a bad request rather than a bad
 * field.
 */
const waypoint = (p) =>
  hasCoords(p)
    ? {
        waypoint: {
          location: {
            latLng: { latitude: Number(p.lat), longitude: Number(p.lng) },
          },
        },
      }
    : { waypoint: { address: String(p.address).trim() } };

/**
 * One leg, one element billed. computeRouteMatrix can take several origins and
 * destinations at once, but it answers with the full cross product and bills
 * origins × destinations — so batching three legs into one call would bill
 * nine elements to use three of them. One call per leg is both cheaper and
 * simpler to read.
 */
async function legMinutes(leg) {
  const res = await fetch(MATRIX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      // Asking for exactly what is used. The field mask is required, and a
      // wide one bills a higher SKU on some routing calls.
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
    },
    body: JSON.stringify({
      origins: [waypoint(leg.from)],
      destinations: [waypoint(leg.to)],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      // CHEAP INSURANCE AGAINST THE WRONG ALBANY. Google's own worked
      // example of an ambiguous address string is "Toledo" resolving to
      // Ohio rather than Spain and the request coming back empty. Sky Blue
      // drives to Albany, Oregon; there is an Albany in New York, Georgia
      // and six other states. The addresses carry ", OR" already, and this
      // costs nothing on top.
      regionCode: "us",
    }),
  });

  if (!res.ok) throw new Error(`routes ${res.status}`);

  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;

  // ROUTE_NOT_FOUND comes back 200 with a condition saying so. Treating that
  // as a zero-minute drive would silently schedule two jobs back to back.
  if (!row || row.condition !== "ROUTE_EXISTS" || !row.duration) return null;

  // "1234s"
  const seconds = Number(String(row.duration).replace(/s$/, ""));
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds / 60);
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const legs = Array.isArray(body?.legs) ? body.legs.slice(0, MAX_LEGS) : [];
  if (legs.length === 0) return Response.json({ minutes: [], source: "none" });

  if (!apiKey()) {
    return Response.json({
      minutes: legs.map(() => null),
      source: "unconfigured",
      reason: "GOOGLE_MAPS_SERVER_KEY is not set; using straight-line distance.",
    });
  }

  const minutes = await Promise.all(
    legs.map(async (leg) => {
      if (!validLeg(leg)) return null;

      const k = keyFor(leg);
      if (cache.has(k)) return cache.get(k);

      try {
        const m = await legMinutes(leg);
        // Cache the null too. A pair with no driving route between them will
        // not grow one, and re-asking on every keystroke is how a free tier
        // stops being free.
        cache.set(k, m);
        return m;
      } catch (err) {
        // Deliberately NOT cached: a 429 or a network blip is temporary, and
        // caching it would turn a bad minute into a bad afternoon.
        console.error("drive-time leg failed", err?.message || err);
        return null;
      }
    })
  );

  return Response.json({ minutes, source: "routes" });
};

export const config = {
  path: "/api/drive-time",
};

/**
 * Testing seam. Not used in production and harmless there: Netlify reads the
 * default export and `config`, and ignores everything else.
 *
 * The cache is module scope on purpose — it survives for as long as the
 * instance stays warm, which is the whole point — and that is exactly what
 * makes a suite of back-to-back requests interfere with itself. Without a
 * way to clear it, each assertion would have to invent a fresh address, and
 * the one thing worth testing here is what the cache does.
 */
export function __resetDriveTimeCache() {
  cache.clear();
}
