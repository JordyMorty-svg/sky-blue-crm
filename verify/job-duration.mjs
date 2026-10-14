// The scheduling rule, checked against the jobs it was fitted to.
//
//   node verify/job-duration.mjs
//
// ---------------------------------------------------------------------------
// WHAT THIS CATCHES
// ---------------------------------------------------------------------------
//
// src/services/durationService.js carries a table of coverage figures in its
// header — "1.5 + price/150 covered 20 of 25 jobs" and so on. A table like
// that is a comment, and comments rot: change the divisor to 200 and the
// prose still says 80% while the field quietly under-books every job again,
// which is the exact fault the module was written to fix.
//
// So the real jobs are in this file and the claims are asserted, not stated.
// Change a number in RULES and this tells you what it cost.
//
// It also pins the behaviour that is easy to break by accident and silent
// when broken: that a bigger ticket is never a shorter block, that adding a
// service never shortens a job, that the travel gap is a floor rather than a
// default, and that a measured drive to Albany beats a guess.
//
// ---------------------------------------------------------------------------
// THE DATA
// ---------------------------------------------------------------------------
//
// Every completed job with a real starts_at and completed_at, 31 Aug – 13 Oct
// 2026, from the Supabase query in claude/pricing-reference.md. Hours are
// wall-clock on site for the two-person crew.
//
// The $3,280 / 34.3 h job is deliberately absent: it ran across two days, so
// its "duration" is an overnight, not work. The 1.1 h gutter job IS here and
// is real — gutter guards reached on a belay off the roof, dangerous rather
// than slow — and it is the single best argument for why the gutter rule is
// fitted to four points and labelled as such rather than trusted.

import {
  DISTANT_TRAVEL_MINUTES,
  FALLBACK_HOURS,
  LOCAL_TRAVEL_MINUTES,
  MIN_HOURS,
  RULES,
  describeGap,
  exceedsOneDay,
  explainDuration,
  milesBetween,
  mustFinishBy,
  readyAfter,
  suggestDuration,
  travelGap,
} from "../src/services/durationService.js";

const WINDOW = [
  ["2026-08-31", 640, 4.1], ["2026-09-01", 449, 3.6], ["2026-09-01", 800, 7.3],
  ["2026-09-02", 399, 2.8], ["2026-09-02", 1000, 4.4], ["2026-09-03", 350, 3.1],
  ["2026-09-08", 400, 2.8], ["2026-09-08", 600, 4.9], ["2026-09-14", 500, 3.4],
  ["2026-09-15", 399, 2.4], ["2026-09-21", 550, 4.6], ["2026-09-21", 300, 4.7],
  ["2026-09-22", 469, 2.4], ["2026-09-22", 410, 1.8], ["2026-09-22", 724, 3.8],
  ["2026-09-23", 375, 1.6], ["2026-09-23", 279, 2.1], ["2026-10-05", 524, 4.6],
  ["2026-10-05", 575, 5.8], ["2026-10-08", 575, 4.3], ["2026-10-09", 299, 2.2],
  ["2026-10-09", 399, 2.2], ["2026-10-12", 375, 4.4], ["2026-10-13", 425, 4.9],
  ["2026-10-13", 399, 2.5],
];

const GUTTER = [
  ["2026-10-06", 360, 2.6], ["2026-09-28", 350, 1.1],
  ["2026-09-23", 349, 1.8], ["2026-09-14", 400, 3.2],
];

const WINDOWS = ["residential-window-washing"];
const GUTTERS = ["gutter-cleaning"];

// Real places, so the distance threshold is tested against the geography it
// was chosen for rather than against numbers invented to pass.
const CORVALLIS = { latitude: 44.5646, longitude: -123.262 };
const CORVALLIS_NE = { latitude: 44.58, longitude: -123.24 };
const ALBANY = { latitude: 44.6365, longitude: -123.1059 };
const NOWHERE = { latitude: null, longitude: null };

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const covers = (rows, keys) =>
  rows.filter(([, price, hours]) => suggestDuration({ price, serviceKeys: keys }) >= hours)
    .length;

console.log("\n-- the rule beats the flat three hours it replaced --\n");

// THE WHOLE REASON THIS EXISTS. If a change makes the rule no better than the
// constant it replaced, nothing else in this file matters.
const flat3 = WINDOW.filter(([, , h]) => h <= 3).length;
const ruleCovers = covers(WINDOW, WINDOWS);

ok(
  "THE POINT: the suggestion covers more jobs than a flat 3 h ever did",
  ruleCovers > flat3,
  `rule ${ruleCovers}/${WINDOW.length}, flat 3 h ${flat3}/${WINDOW.length}`
);
ok(
  "THE POINT: it covers at least 4 window jobs in 5",
  ruleCovers / WINDOW.length >= 0.8,
  `${ruleCovers}/${WINDOW.length}`
);
ok(
  "...and the flat 3 h really was as bad as the comment says",
  flat3 === 10,
  `flat 3 h covered ${flat3}, header claims 10`
);

// Over-booking is the other failure, and it is the one nobody notices,
// because an empty afternoon does not phone anybody. Without this, "block
// everything for twelve hours" would score 25/25 above.
const slack = WINDOW.reduce((sum, [, price, hours]) => {
  const s = suggestDuration({ price, serviceKeys: WINDOWS });
  return sum + Math.max(0, s - hours);
}, 0);
ok(
  "THE POINT: and it does not buy that coverage with an empty calendar",
  slack / WINDOW.length <= 1.5,
  `${(slack / WINDOW.length).toFixed(2)} h of unused block per job`
);

console.log("-- the shape of the curve --\n");

// Monotonic: a bigger ticket can never be a shorter block. Easy to break by
// swapping a sign in the rule; impossible to notice on one screen.
let monotonic = true;
for (let p = 100; p <= 2000; p += 25) {
  const a = suggestDuration({ price: p, serviceKeys: WINDOWS });
  const b = suggestDuration({ price: p + 25, serviceKeys: WINDOWS });
  if (b < a) monotonic = false;
}
ok("a bigger ticket is never a shorter block", monotonic);

// The setup term is what buys the coverage, so it has to actually be there.
const tiny = suggestDuration({ price: 1, serviceKeys: WINDOWS });
ok(
  "THE POINT: a trivial ticket still books the setup time",
  tiny >= 1,
  `$1 suggested ${tiny} h`
);

// Round UP, not nearest: the input steps in halves and under-booking is the
// fault being fixed. 1.5 + 400/150 = 4.1666, which rounds DOWN to 4.0.
const four = suggestDuration({ price: 400, serviceKeys: WINDOWS });
ok(
  "THE POINT: the half-hour rounding goes up, never down",
  four === 4.5,
  `$400 gave ${four} h, exact is ${(1.5 + 400 / 150).toFixed(3)}`
);

// THE MIN_HOURS CLAMP IS CURRENTLY UNREACHABLE, and deleting it does not
// break anything — a mutant proved that. It is kept as a guard for a future
// rule, so what gets asserted is the invariant that makes it dead: every
// rule's setup already clears the floor. Add a rule with a 15-minute setup
// and this fails, which is the moment the clamp starts mattering.
ok(
  "every service rule already books more than the minimum before any ticket",
  Object.values(RULES).every((r) => r.setup >= MIN_HOURS),
  JSON.stringify(
    Object.entries(RULES).map(([k, r]) => [k, r.setup])
  )
);

ok(
  "a whole-day job is flagged as one",
  exceedsOneDay(suggestDuration({ price: 1200, serviceKeys: WINDOWS })) &&
    !exceedsOneDay(suggestDuration({ price: 400, serviceKeys: WINDOWS }))
);

console.log("-- services are not all the same --\n");

ok(
  "the gutter rule covers all four gutter jobs",
  covers(GUTTER, GUTTERS) === GUTTER.length,
  `${covers(GUTTER, GUTTERS)}/${GUTTER.length}`
);

// Gutters earn more per hour than windows, so the same money must buy LESS
// calendar. If someone copies the window numbers into the gutter rule this is
// what notices.
ok(
  "THE POINT: gutters book shorter than windows for the same money",
  suggestDuration({ price: 400, serviceKeys: GUTTERS }) <
    suggestDuration({ price: 400, serviceKeys: WINDOWS }),
  `gutter ${suggestDuration({ price: 400, serviceKeys: GUTTERS })} h vs ` +
    `window ${suggestDuration({ price: 400, serviceKeys: WINDOWS })} h`
);

// A job that is windows AND gutters shares one price, so the longer rule
// wins. Without this, ticking a second service could shorten the job, which
// is nonsense on screen and dangerous on the day.
let neverShortens = true;
for (const p of [300, 449, 700, 1180]) {
  const both = suggestDuration({ price: p, serviceKeys: [...WINDOWS, ...GUTTERS] });
  if (both < suggestDuration({ price: p, serviceKeys: WINDOWS })) neverShortens = false;
  if (both < suggestDuration({ price: p, serviceKeys: GUTTERS })) neverShortens = false;
}
ok("THE POINT: adding a service never shortens a job", neverShortens);

// A service with no jobs behind it borrows the window rule rather than
// getting an invented one. Over-booking an unknown is the cheap mistake.
ok(
  "an unmeasured service falls back rather than guessing",
  suggestDuration({ price: 500, serviceKeys: ["solar-panel-cleaning"] }) ===
    suggestDuration({ price: 500, serviceKeys: WINDOWS })
);
ok(
  "a service key nobody recognises does not crash or return nothing",
  suggestDuration({ price: 500, serviceKeys: ["not-a-real-service"] }) > 0
);

console.log("-- when it refuses to answer --\n");

// An estimate built on a missing price is worse than an empty field: the
// empty field asks the question out loud.
for (const [label, price] of [
  ["no price", undefined], ["zero", 0], ["empty string", ""],
  ["text", "soon"], ["negative", -200], ["null", null],
]) {
  ok(`${label} suggests nothing at all`, suggestDuration({ price, serviceKeys: WINDOWS }) === null);
}
ok(
  "...and the hint says what is missing instead of showing a number",
  /price/i.test(explainDuration({ price: 0, serviceKeys: WINDOWS }))
);
ok(
  "the hint quotes the arithmetic, so the number can be argued with",
  explainDuration({ price: 449, serviceKeys: WINDOWS }).includes(
    `$${RULES["residential-window-washing"].per}`
  ),
  explainDuration({ price: 449, serviceKeys: WINDOWS })
);
ok(
  "THE POINT: a rule fitted to a handful of jobs says so on screen",
  /only 4 jobs/i.test(explainDuration({ price: 400, serviceKeys: GUTTERS })),
  explainDuration({ price: 400, serviceKeys: GUTTERS })
);

console.log("-- the road between two jobs --\n");

// ASSERTED AGAINST THE BEHAVIOUR, NOT AGAINST THE CONSTANT. The first draft
// of these two read `=== DISTANT_TRAVEL_MINUTES` and `=== LOCAL_TRAVEL_MINUTES`,
// which is a tautology: set both constants to 15 and the out-of-town gap
// vanishes while this file reports 35 passing. A mutant found it. The gap
// between the two is the thing that has to be true, so the gap is what is
// checked — plus one literal, so "15 everywhere" cannot pass either.
const albany = travelGap(CORVALLIS, ALBANY).minutes;
const local = travelGap(CORVALLIS, CORVALLIS_NE).minutes;

ok(
  "THE POINT: Albany is given materially more road than across town",
  albany > local,
  `Albany ${albany} min vs local ${local} min, ` +
    `${milesBetween(CORVALLIS, ALBANY).toFixed(1)} mi apart`
);
ok(
  "...and the two gaps are the quarter and half hour they are meant to be",
  local === 15 && albany === 30,
  `local ${local}, distant ${albany}`
);
ok(
  "the constants the app imports agree with that",
  LOCAL_TRAVEL_MINUTES === local && DISTANT_TRAVEL_MINUTES === albany
);
ok(
  "THE POINT: a job with no address gets the local gap AND says it is a guess",
  travelGap(CORVALLIS, NOWHERE).minutes === LOCAL_TRAVEL_MINUTES &&
    travelGap(CORVALLIS, NOWHERE).basis === "assumed"
);
ok(
  "...and a known distance is never reported as a guess",
  travelGap(CORVALLIS, ALBANY).basis === "distance"
);

// The whole point of paying Google: a real route overrides the straight line.
ok(
  "THE POINT: a measured drive beats the straight-line guess",
  travelGap(CORVALLIS, CORVALLIS_NE, 38).minutes === 38 &&
    travelGap(CORVALLIS, CORVALLIS_NE, 38).basis === "driven",
  JSON.stringify(travelGap(CORVALLIS, CORVALLIS_NE, 38))
);

// ...but it cannot drop below the floor. A routed four-minute hop is still
// fifteen minutes of gap, because the gap is not only driving.
ok(
  "THE POINT: a short measured drive is still floored at the local minimum",
  travelGap(CORVALLIS, CORVALLIS_NE, 4).minutes === LOCAL_TRAVEL_MINUTES,
  `got ${travelGap(CORVALLIS, CORVALLIS_NE, 4).minutes}`
);
ok(
  "a zero-minute drive does not collapse the gap",
  travelGap(CORVALLIS, CORVALLIS_NE, 0).minutes === LOCAL_TRAVEL_MINUTES
);
ok(
  "a nonsense drive time is ignored rather than trusted",
  travelGap(CORVALLIS, ALBANY, NaN).basis === "distance" &&
    travelGap(CORVALLIS, ALBANY, -5).basis === "distance"
);
ok(
  "the gap rounds up to the minute — 26.2 minutes of road is 27",
  travelGap(CORVALLIS, ALBANY, 26.2).minutes === 27
);

ok(
  "the screen can tell the three cases apart",
  describeGap(travelGap(CORVALLIS, ALBANY, 26)).includes("drive") &&
    describeGap(travelGap(CORVALLIS, NOWHERE)).includes("no address") &&
    describeGap(travelGap(CORVALLIS, ALBANY)).includes("mi away")
);

const noon = new Date("2026-10-20T12:00:00");
ok(
  "ready-after and must-finish-by are the same gap seen from each end",
  readyAfter(noon, 15).getTime() - noon.getTime() === 15 * 60000 &&
    noon.getTime() - mustFinishBy(noon, 15).getTime() === 15 * 60000
);

console.log("-- the legacy fallback --\n");

// Rows booked before any of this exists have a null duration. Three hours is
// what was most likely meant at the time; it is NOT a suggestion for a new
// job, and if the two were ever the same number this check would be the only
// thing saying so.
ok(
  "a null duration still renders as something",
  FALLBACK_HOURS > 0 && Number.isFinite(FALLBACK_HOURS)
);
ok(
  "THE POINT: the legacy fallback is not what a real job would be given",
  suggestDuration({ price: 449, serviceKeys: WINDOWS }) !== FALLBACK_HOURS,
  `$449 suggests ${suggestDuration({ price: 449, serviceKeys: WINDOWS })}, fallback is ${FALLBACK_HOURS}`
);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
