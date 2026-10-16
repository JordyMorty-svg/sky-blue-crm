// The server half of drive times, with Google faked.
//
//   node verify/drive-time-function.mjs
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, WHICH IS THE SAME REASON AS LAST TIME
// ---------------------------------------------------------------------------
//
// verify/drive-time.mjs was written after driveTimeService.js shipped three
// copies of one bug, and its header says the lesson out loud: a module that
// talks to the network is not untestable, because `fetch` is a global a test
// can hand over.
//
// netlify/functions/drive-time.mjs is the other half of that same wire and
// did not get the same treatment. Within the day it shipped a bug of exactly
// the predicted kind: its cache key was written for coordinate waypoints, an
// address waypoint has no `lat`, `round4(undefined)` is NaN, and so EVERY
// address-based leg in the process collided on "NaN,NaN>NaN,NaN". Since
// nulls are cached deliberately, the first address that failed to route
// handed its null to every other address on the instance — and a customer
// whose address had just been fixed still read "no route came back",
// because nothing was being asked on their behalf.
//
// The identical fix had been made in driveTimeService.js an hour earlier.
// One copy got it; the untested mirror did not.

import handler, {
  __resetDriveTimeCache,
} from "../netlify/functions/drive-time.mjs";

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

/* --- a fake Google --------------------------------------------------------
 *
 * Records every request so the assertions can ask what was SENT, and lets a
 * test decide what comes back per call — which is how the cache is observed
 * at all: ask twice, change the answer, and see which one you get.
 */
let calls = [];
let replies = [];

globalThis.fetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const next = replies.shift() ?? { rows: [] };
  if (next.throws) throw new Error(next.throws);
  return {
    ok: next.status === undefined || (next.status >= 200 && next.status < 300),
    status: next.status ?? 200,
    json: async () => next.rows,
  };
};

const route = (seconds) => ({
  rows: [{ originIndex: 0, destinationIndex: 0, condition: "ROUTE_EXISTS", duration: `${seconds}s` }],
});
const noRoute = { rows: [{ originIndex: 0, destinationIndex: 0, condition: "ROUTE_NOT_FOUND" }] };

const post = (legs) =>
  handler(
    new Request("https://example.test/api/drive-time", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs }),
    })
  );

const CORV = { lat: 44.5646, lng: -123.262 };
const NE = { lat: 44.58, lng: -123.24 };
const A1 = { address: "111 First St, Corvallis, OR" };
const A2 = { address: "999 Totally Different Ave, Albany, OR" };

process.env.GOOGLE_MAPS_SERVER_KEY = "test-key";

console.log("\n-- the cache key --\n");

// THE BUG — and the first version of this test did not reproduce it.
//
// It used coordinates for the origin and an address only for the
// destination, so the broken key still produced two distinct strings
// ("44.5646,-123.262>NaN,NaN" and "44.58,-123.24>NaN,NaN") and the mutant
// survived. The real case is BOTH ENDS being addresses, which is what 69 of
// 97 jobs looked like: then every leg in the day keyed as
// "NaN,NaN>NaN,NaN", and the first answer was handed to all of them.
//
// A test of a bug that does not reproduce the bug is worth less than no
// test, because it is also a claim that the bug is covered.
const A3 = { address: "222 Third Ave, Philomath, OR" };
const A4 = { address: "444 Fourth Way, Albany, OR" };

__resetDriveTimeCache();
calls = [];
replies = [route(600), route(1500)];
const r1 = await (await post([{ from: A1, to: A2 }])).json();
const r2 = await (await post([{ from: A3, to: A4 }])).json();

ok(
  "THE POINT: two legs with addresses at BOTH ends are two cache entries",
  calls.length === 2,
  `${calls.length} calls to Google for two entirely different journeys`
);
ok(
  "...so the second gets its own answer, not the first one's",
  r1.minutes[0] === 10 && r2.minutes[0] === 25,
  `${JSON.stringify(r1.minutes)} then ${JSON.stringify(r2.minutes)}`
);
// Consecutive jobs share an endpoint: A->B then B->C. Those must not
// collapse either.
__resetDriveTimeCache();
calls = [];
replies = [route(300), route(1200)];
const hop1 = await (await post([{ from: A1, to: A2 }])).json();
const hop2 = await (await post([{ from: A2, to: A3 }])).json();
ok(
  "...and a chain of stops keeps each leg separate",
  calls.length === 2 && hop1.minutes[0] === 5 && hop2.minutes[0] === 20,
  `${JSON.stringify(hop1.minutes)} then ${JSON.stringify(hop2.minutes)}`
);

// The poisoning case, exactly as it happened: the first address fails, and
// every later address inherits the cached null. Both ends addresses again,
// for the reason above.
__resetDriveTimeCache();
calls = [];
replies = [noRoute, route(900)];
const bad = await (await post([{ from: A1, to: A2 }])).json();
const good = await (await post([{ from: A3, to: A4 }])).json();
ok(
  "THE POINT: a failed address does not poison every other address",
  bad.minutes[0] === null && good.minutes[0] === 15,
  `${JSON.stringify(bad.minutes)} then ${JSON.stringify(good.minutes)}`
);

// ...but the SAME pair really is cached, which is the point of having one.
__resetDriveTimeCache();
calls = [];
replies = [route(420), route(9999)];
const first = await (await post([{ from: CORV, to: A1 }])).json();
const second = await (await post([{ from: CORV, to: A1 }])).json();
ok(
  "the same address pair is asked about once",
  calls.length === 1 && first.minutes[0] === 7 && second.minutes[0] === 7,
  `${calls.length} calls`
);

// A null is cached too, deliberately: a pair with no route between them will
// not grow one, and re-asking on every render is how a free tier stops being
// free. Nothing asserted it, so a mutant that dropped it survived.
__resetDriveTimeCache();
calls = [];
replies = [noRoute, route(600)];
const dead1 = await (await post([{ from: A1, to: A2 }])).json();
const dead2 = await (await post([{ from: A1, to: A2 }])).json();
ok(
  "THE POINT: a 'no route' answer is cached, not re-asked every render",
  calls.length === 1 && dead1.minutes[0] === null && dead2.minutes[0] === null,
  `${calls.length} calls for the same unroutable pair`
);
__resetDriveTimeCache();
calls = [];
replies = [route(60), route(120)];
const asCoords = await (
  await post([{ from: CORV, to: { lat: 44.58, lng: -123.24 } }])
).json();
const asText = await (
  await post([{ from: CORV, to: { address: "44.58,-123.24" } }])
).json();
ok(
  "an address is not confused with coordinates of the same text",
  calls.length === 2 && asCoords.minutes[0] === 1 && asText.minutes[0] === 2,
  `${calls.length} calls, got ${asCoords.minutes[0]} then ${asText.minutes[0]}`
);

console.log("-- what gets sent to Google --\n");

__resetDriveTimeCache();
calls = [];
replies = [route(600)];
await post([{ from: CORV, to: A1 }]);
const body = calls[0].body;

ok(
  "coordinates go as a latLng location",
  body.origins[0].waypoint.location.latLng.latitude === 44.5646,
  JSON.stringify(body.origins[0])
);
// `address` is a sibling of placeId, NOT nested under location. Getting this
// wrong is a 400 that reads like a bad request rather than a bad field.
ok(
  "THE POINT: an address goes as a bare `address` on the waypoint",
  body.destinations[0].waypoint.address === A1.address &&
    body.destinations[0].waypoint.location === undefined,
  JSON.stringify(body.destinations[0])
);
ok(
  "the region is pinned, so Albany is not the one in New York",
  body.regionCode === "us",
  JSON.stringify(body.regionCode)
);
ok(
  "traffic-unaware, which is both the cheaper tier and the right answer days ahead",
  body.routingPreference === "TRAFFIC_UNAWARE"
);
ok("the key travels in the header, never the body", calls[0].headers["X-Goog-Api-Key"] === "test-key");

console.log("-- what comes back --\n");

__resetDriveTimeCache();
calls = [];
replies = [noRoute];
const nr = await (await post([{ from: CORV, to: A2 }])).json();
ok(
  "THE POINT: ROUTE_NOT_FOUND is null, never a zero-minute drive",
  nr.minutes[0] === null,
  "zero would be floored to the buffer and reported as measured"
);

__resetDriveTimeCache();
calls = [];
replies = [{ rows: [{ condition: "ROUTE_EXISTS" }] }];
ok(
  "a route with no duration is null",
  (await (await post([{ from: CORV, to: NE }])).json()).minutes[0] === null
);

__resetDriveTimeCache();
calls = [];
replies = [{ status: 403 }];
const denied = await (await post([{ from: CORV, to: A1 }])).json();
ok("a 403 from Google answers null rather than throwing", denied.minutes[0] === null);

// A refusal is temporary. Caching it would turn a bad minute into a bad day.
__resetDriveTimeCache();
calls = [];
replies = [{ throws: "network down" }, route(300)];
await post([{ from: CORV, to: A2 }]);
const recovered = await (await post([{ from: CORV, to: A2 }])).json();
ok(
  "THE POINT: a thrown request is not cached, so the next attempt can succeed",
  recovered.minutes[0] === 5,
  JSON.stringify(recovered.minutes)
);

console.log("-- legs it refuses to send --\n");

__resetDriveTimeCache();
calls = [];
replies = [];
const nothing = await (await post([{ from: CORV, to: { lat: null, address: null } }])).json();
ok(
  "a leg with neither coordinates nor an address is never sent",
  calls.length === 0 && nothing.minutes[0] === null
);

__resetDriveTimeCache();
calls = [];
replies = [];
const blank = await (await post([{ from: CORV, to: { address: "   " } }])).json();
ok("a whitespace address is not an address", calls.length === 0 && blank.minutes[0] === null);

const empty = await (await post([])).json();
ok("no legs makes no request", empty.minutes.length === 0);

console.log("-- the shape of the endpoint --\n");

const get = await handler(new Request("https://example.test/api/drive-time"));
ok("GET is refused", get.status === 405);

const badJson = await handler(
  new Request("https://example.test/api/drive-time", { method: "POST", body: "{{{" })
);
ok("malformed JSON is a 400, not a crash", badJson.status === 400);

// An unset key is a configuration state, not an error. Scheduling must not
// break because a billing account lapsed.
delete process.env.GOOGLE_MAPS_SERVER_KEY;
delete process.env.GOOGLE_MAPS_API_KEY;
calls = [];
const unconf = await post([{ from: CORV, to: A1 }]);
const unconfBody = await unconf.json();
ok(
  "THE POINT: no key is a 200 that says so, not a failure",
  unconf.status === 200 &&
    unconfBody.source === "unconfigured" &&
    unconfBody.minutes[0] === null &&
    calls.length === 0,
  JSON.stringify(unconfBody)
);
process.env.GOOGLE_MAPS_SERVER_KEY = "test-key";

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
