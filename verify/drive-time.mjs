// The wire between the calendar and Google, with the network faked.
//
//   node verify/drive-time.mjs
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, WHICH IS THE WHOLE POINT
// ---------------------------------------------------------------------------
//
// src/services/driveTimeService.js shipped with three copies of a bug that
// its neighbour durationService.js had already been cured of — `Number(null)`
// is 0, and 0 is finite. durationService had a test suite and lost the bug on
// the suite's first run. This file talks to the network, felt untestable, got
// no suite, and kept all three copies for a day.
//
// It is not untestable. `fetch` is a global; a test can hand it one. That is
// the entire trick and it took four lines.
//
// The worst of the three is the one to keep in mind while reading the
// assertions below: a null in the server's reply became 0 minutes, which
// travelGap() floored to 15 and labelled `basis: "driven"`. An unroutable leg
// came out of the system reading "15 min drive" — a guess wearing a
// measurement's clothes, which is strictly worse than the guess alone,
// because the whole reason `basis` exists is so a screen never states a
// number it does not have.

import {
  __resetDriveTimeCache,
  driveTimeStatus,
  fetchDriveMinutes,
  fetchDriveMinutesBetween,
} from "../src/services/driveTimeService.js";
import { travelGap } from "../src/services/durationService.js";

const CORVALLIS = { latitude: 44.5646, longitude: -123.262 };
const ALBANY = { latitude: 44.6365, longitude: -123.1059 };
const NE = { latitude: 44.58, longitude: -123.24 };
const NO_COORDS = { latitude: null, longitude: null, address: "123 Somewhere" };
const BLANK = { latitude: "", longitude: "" };

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

/* --- the fake network ------------------------------------------------------
 *
 * Records every request so the assertions can ask what was actually SENT, not
 * only what came back. Bug #1 was entirely about what was sent.
 */
let sent = [];
let reply = null;
let throwWith = null;

globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  if (throwWith) throw new Error(throwWith);
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => {
      if (reply.notJson) throw new Error("not json");
      return reply.body;
    },
  };
};

function given({ status = 200, body = {}, notJson = false, throws = null } = {}) {
  sent = [];
  reply = { status, body, notJson };
  throwWith = throws;
  __resetDriveTimeCache();
}

// console.warn is deliberate behaviour here, not noise. Captured so the suite
// can assert on it and so running this file stays quiet.
const warnings = [];
console.warn = (...a) => warnings.push(a.join(" "));

console.log("\n-- what gets sent --\n");

given({ body: { minutes: [12], source: "routes" } });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "a leg with coordinates at both ends is asked for",
  sent.length === 1 && sent[0].body.legs.length === 1,
  JSON.stringify(sent)
);
ok(
  "...with the real coordinates, not rounded to death",
  sent[0].body.legs[0].from.lat === 44.5646 && sent[0].body.legs[0].to.lng === -123.1059,
  JSON.stringify(sent[0].body.legs[0])
);

// BUG #1. `Number(null)` is 0, so a job with no pin was sent to Google as
// 0,0 — a point in the Gulf of Guinea — and whatever came back was treated
// as the drive to that customer's house.
given({ body: { minutes: [], source: "routes" } });
await fetchDriveMinutes([[CORVALLIS, NO_COORDS]]);
ok(
  "THE POINT: a job with no coordinates is never sent as 0,0",
  sent.length === 0,
  JSON.stringify(sent)
);

given({ body: { minutes: [], source: "routes" } });
await fetchDriveMinutes([[BLANK, ALBANY]]);
ok(
  "...nor are empty strings, which Number() also turns into zero",
  sent.length === 0,
  JSON.stringify(sent)
);

given({ body: { minutes: [], source: "routes" } });
const none = await fetchDriveMinutes([[CORVALLIS, NO_COORDS]]);
ok("a leg that cannot be asked about answers null", none[0] === null);

given({ body: { minutes: [9], source: "routes" } });
const mixed = await fetchDriveMinutes([
  [CORVALLIS, NO_COORDS],
  [CORVALLIS, ALBANY],
]);
ok(
  "THE POINT: results stay aligned with the pairs that were passed in",
  mixed.length === 2 && mixed[0] === null && mixed[1] === 9,
  JSON.stringify(mixed)
);
ok(
  "...and only the askable leg was asked about",
  sent[0].body.legs.length === 1
);

console.log("-- what comes back --\n");

// BUG #2, and the one that matters most. A null minute became 0, which
// travelGap floored to 15 and stamped as measured.
given({ body: { minutes: [null], source: "routes" } });
const nulled = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "THE POINT: a null from the server stays null, it does not become zero",
  nulled[0] === null,
  `got ${JSON.stringify(nulled[0])}`
);
ok(
  "THE POINT: ...so an unroutable leg is reported as an estimate, not a drive",
  travelGap(CORVALLIS, ALBANY, nulled[0]).basis === "distance",
  `basis came back ${travelGap(CORVALLIS, ALBANY, nulled[0]).basis}`
);

given({ body: { minutes: [26], source: "routes" } });
const real = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "a real answer is reported as a drive",
  travelGap(CORVALLIS, ALBANY, real[0]).basis === "driven" &&
    travelGap(CORVALLIS, ALBANY, real[0]).minutes === 26
);

given({ body: { minutes: ["nonsense"], source: "routes" } });
const junk = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok("a non-numeric answer is null, not NaN", junk[0] === null);

given({ body: { source: "routes" } });
const missing = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok("a reply with no minutes array does not crash", missing[0] === null);

console.log("-- why it is not working, said out loud --\n");

// A silent fallback is the right behaviour and a useless diagnostic. These
// four states have four different fixes and used to look identical.
given({ status: 404 });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "THE POINT: a 404 is named as 'not deployed', because that is what it means",
  driveTimeStatus() === "not_deployed",
  driveTimeStatus()
);

given({ status: 500 });
const failed = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok("a 500 is an http failure, not a missing deploy", driveTimeStatus() === "http");
// A mutant that returned zeros from the error path survived the status check
// above, because the status was all that was being looked at. Zero minutes is
// the worst possible answer here: travelGap floors it to 15 and calls it
// measured, which is bug #2 coming back through a different door.
ok(
  "THE POINT: an http error answers null, never a number",
  failed.length === 1 && failed[0] === null,
  JSON.stringify(failed)
);
ok(
  "...so the screen still says 'estimate', not 'drive'",
  travelGap(CORVALLIS, ALBANY, failed[0]).basis === "distance"
);

given({ body: { minutes: [null], source: "unconfigured", reason: "no key" } });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "THE POINT: the server saying the key is unset is not thrown away",
  driveTimeStatus() === "unconfigured",
  driveTimeStatus()
);

given({ throws: "network down" });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok("a thrown fetch is 'offline' and does not propagate", driveTimeStatus() === "offline");

given({ body: { minutes: [26], source: "routes" } });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok("a working call reports ok", driveTimeStatus() === "ok");

given({ status: 404 });
warnings.length = 0;
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
await fetchDriveMinutes([[CORVALLIS, NE]]);
ok(
  "the warning is printed once a session, not once a render",
  warnings.length === 1,
  `${warnings.length} warnings`
);
ok(
  "...and it says what to do about it",
  /drive-time/.test(warnings[0]) && /not_deployed/.test(warnings[0]),
  warnings[0]
);

console.log("-- the cache --\n");

given({ body: { minutes: [26], source: "routes" } });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
const before = sent.length;
const again = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "THE POINT: the same pair is not asked twice",
  sent.length === before && again[0] === 26,
  `${sent.length} requests, got ${again[0]}`
);

given({ body: { minutes: [null], source: "routes" } });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
const nullBefore = sent.length;
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "a null is cached too — a pair with no route will not grow one",
  sent.length === nullBefore,
  "otherwise every render re-asks and the free tier stops being free"
);

// A network blip is temporary. Caching it would turn a bad minute into a bad
// afternoon.
given({ throws: "blip" });
await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
reply = { status: 200, body: { minutes: [31], source: "routes" }, notJson: false };
throwWith = null;
const recovered = await fetchDriveMinutes([[CORVALLIS, ALBANY]]);
ok(
  "THE POINT: a failure is not cached, so the next attempt can succeed",
  recovered[0] === 31,
  `got ${JSON.stringify(recovered[0])}`
);

given({ body: { minutes: [7], source: "routes" } });
ok(
  "the single-pair helper agrees with the plural one",
  (await fetchDriveMinutesBetween(CORVALLIS, ALBANY)) === 7
);

given({ body: { minutes: [], source: "routes" } });
ok(
  "nothing to ask about makes no request at all",
  (await fetchDriveMinutes([])).length === 0 && sent.length === 0
);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
