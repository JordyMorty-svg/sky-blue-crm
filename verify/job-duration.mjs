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

// RUN IN THE CREW'S TIMEZONE, and this is load-bearing rather than tidy.
//
// planGapsByDay groups by LOCAL calendar day. Under TZ=UTC — which is what a
// CI container defaults to — grouping by local day and grouping by
// `toISOString().slice(0,10)` give identical answers for every input, so the
// assertion that the two differ cannot fail and the mutant that swaps them
// survives. It did, on the first run.
//
// Corvallis is Pacific. Setting it here makes the check mean something and
// makes the suite test the condition the app actually ships into.
process.env.TZ = "America/Los_Angeles";

import {
  DISTANT_TRAVEL_MINUTES,
  FALLBACK_HOURS,
  LOCAL_TRAVEL_MINUTES,
  MIN_HOURS,
  RULES,
  describeGap,
  exceedsOneDay,
  explainDuration,
  gapLabel,
  milesBetween,
  mustFinishBy,
  planGaps,
  planGapsByDay,
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

// THE STRIP ONLY HAS ROOM FOR A NUMBER, and three different states all
// produced "15m": a routed drive under the floor, a straight-line estimate
// across town, and a pair with no coordinates at all. In a town the size of
// Corvallis the first two are the normal answer, so the screen was showing
// the same thing whether the routing worked or had never been called — two
// days of reasonably suspecting a broken API key.
ok(
  "THE POINT: a measured gap and a guessed one do not read the same",
  gapLabel(travelGap(CORVALLIS, CORVALLIS_NE, 7)) !==
    gapLabel(travelGap(CORVALLIS, CORVALLIS_NE)),
  `${gapLabel(travelGap(CORVALLIS, CORVALLIS_NE, 7))} vs ` +
    `${gapLabel(travelGap(CORVALLIS, CORVALLIS_NE))}`
);
ok(
  "...even when the routed drive is floored to the same number of minutes",
  travelGap(CORVALLIS, CORVALLIS_NE, 7).minutes ===
    travelGap(CORVALLIS, CORVALLIS_NE).minutes &&
    gapLabel(travelGap(CORVALLIS, CORVALLIS_NE, 7)) === "15m" &&
    gapLabel(travelGap(CORVALLIS, CORVALLIS_NE)) === "~15m",
  "both are 15 minutes; only one of them was measured"
);
ok(
  "a pair with no coordinates is marked as a guess too",
  gapLabel(travelGap(CORVALLIS, NOWHERE)) === "~15m"
);
ok(
  "a real Albany drive carries no tilde",
  gapLabel(travelGap(CORVALLIS, ALBANY, 26)) === "26m"
);
ok(
  "an empty gap does not render the word undefined",
  gapLabel(null) === ""
);

ok(
  "the screen can tell the three cases apart",
  describeGap(travelGap(CORVALLIS, ALBANY, 26)).includes("drive") &&
    describeGap(travelGap(CORVALLIS, NOWHERE)).includes("map pin") &&
    describeGap(travelGap(CORVALLIS, ALBANY)).includes("mi away")
);

// THE WORDING THAT WASTED A DAY. A job with no coordinates nearly always
// still has an address — on the lead, or frozen onto the job itself — so
// saying "no address on file" describes a state the user can see is false,
// and invites them to go looking for the wrong thing. It is the pin that is
// missing.
ok(
  "THE POINT: a missing pin is never reported as a missing address",
  !/address/i.test(describeGap(travelGap(CORVALLIS, NOWHERE))),
  describeGap(travelGap(CORVALLIS, NOWHERE))
);
ok(
  "...and it says plainly that the number is an estimate",
  /estimat/i.test(describeGap(travelGap(CORVALLIS, NOWHERE))),
  describeGap(travelGap(CORVALLIS, NOWHERE))
);

const noon = new Date("2026-10-20T12:00:00");
ok(
  "ready-after and must-finish-by are the same gap seen from each end",
  readyAfter(noon, 15).getTime() - noon.getTime() === 15 * 60000 &&
    noon.getTime() - mustFinishBy(noon, 15).getTime() === 15 * 60000
);

console.log("-- the strips across a whole day --\n");

// A day with three stops. Written out of order on purpose: planGaps sorts,
// and a caller handing it an unsorted list is the normal case (the job being
// booked is appended last and may start first).
const at = (h, m = 0) => new Date(2026, 9, 20, h, m, 0, 0);
const DAY = [
  { id: "noon", start: at(12), end: at(14), place: ALBANY },
  { id: "morning", start: at(8), end: at(10, 30), place: CORVALLIS },
  { id: "late", start: at(16), end: at(18), place: CORVALLIS_NE },
];

const plan = planGaps(DAY);

ok(
  "a day of three stops has two gaps, not three",
  plan.length === 2,
  `${plan.length}`
);
ok(
  "...in time order however the list arrived",
  plan[0].fromId === "morning" && plan[0].toId === "noon" &&
    plan[1].fromId === "noon" && plan[1].toId === "late",
  JSON.stringify(plan.map((g) => `${g.fromId}>${g.toId}`))
);

// THE BUG THIS FUNCTION EXISTS TO STOP. The first version paired every job
// with the one being booked, so the strip under the 8am job showed the drive
// to the LAST stop of the day. With three stops that is visibly wrong and
// with two it is invisible, which is why it shipped for an hour.
ok(
  "THE POINT: a strip measures the drive to the NEXT stop, not to the last one",
  plan[0].gap.minutes === travelGap(CORVALLIS, ALBANY).minutes &&
    plan[0].gap.minutes !== travelGap(CORVALLIS, CORVALLIS_NE).minutes,
  `morning->noon is ${plan[0].gap.minutes}, morning->late would be ` +
    `${travelGap(CORVALLIS, CORVALLIS_NE).minutes}`
);
ok(
  "a strip is anchored to the end of the job it follows",
  plan[0].at.getTime() === at(10, 30).getTime()
);

// 10:30 finish + 30 min to Albany = 11:00, and the next job starts at noon.
ok("an hour and a half of slack is not flagged as tight", plan[0].tight === false);

// 2pm finish in Albany + 30 min back = 2:30, next starts at 4. Fine.
ok("...nor is ninety minutes the other way", plan[1].tight === false);

const TIGHT = [
  { id: "a", start: at(9), end: at(12), place: CORVALLIS },
  { id: "b", start: at(12, 5), end: at(15), place: ALBANY },
];
const tightPlan = planGaps(TIGHT);
ok(
  "THE POINT: five minutes between Corvallis and Albany is flagged as tight",
  tightPlan[0].tight === true,
  `gap says ${tightPlan[0].gap.minutes} min`
);

const EXACT = [
  { id: "a", start: at(9), end: at(12), place: CORVALLIS },
  { id: "b", start: at(12, 30), end: at(15), place: ALBANY },
];
ok(
  "...and arriving exactly as the gap runs out is allowed",
  planGaps(EXACT)[0].tight === false
);

// Two jobs booked over each other have no road between them. Emitting a gap
// anyway drew a red strip at the END of the first job on a pair whose second
// job had started an hour earlier — pointing an hour away from a real
// problem. The overlapping blocks and the conflict warning already say it.
const OVERLAP = [
  { id: "long", start: at(9), end: at(12), place: CORVALLIS },
  { id: "over", start: at(11), end: at(14), place: ALBANY },
];
ok(
  "THE POINT: two jobs booked over each other get no travel strip",
  planGaps(OVERLAP).length === 0,
  JSON.stringify(planGaps(OVERLAP).map((g) => [`${g.fromId}>${g.toId}`, g.at]))
);
ok(
  "...but back to back with no gap at all still gets one, flagged tight",
  (() => {
    const touching = planGaps([
      { id: "a", start: at(9), end: at(12), place: CORVALLIS },
      { id: "b", start: at(12), end: at(14), place: ALBANY },
    ]);
    return touching.length === 1 && touching[0].tight === true;
  })(),
  "zero minutes between two jobs is the fault, not an absence of one"
);

ok(
  "a lone job has no strip, and an empty day does not crash",
  planGaps([DAY[0]]).length === 0 && planGaps([]).length === 0 && planGaps().length === 0
);
ok(
  "a stop with no times is dropped rather than drawn at the epoch",
  planGaps([...DAY, { id: "junk", start: null, end: null, place: CORVALLIS }]).length === 2
);

// The routed override has to survive the trip through planGaps, or paying
// Google buys nothing.
ok(
  "THE POINT: a measured drive reaches the strip",
  planGaps(DAY, (a, b) => (a === "morning" && b === "noon" ? 41 : null))[0].gap
    .minutes === 41
);
ok(
  "...and only for the pair it was fetched for",
  planGaps(DAY, (a, b) => (a === "morning" && b === "noon" ? 41 : null))[1].gap
    .basis === "distance"
);

console.log("-- a whole calendar, not just one day --\n");

// The failure this guards: hand a week of jobs to planGaps() and it draws a
// gap between Monday's last job and Tuesday's first — fifteen minutes of
// travel across an overnight. Nobody drives home and back inside the gap.
const on = (d, h, m = 0) => new Date(2026, 9, d, h, m, 0, 0);
const WEEK = [
  { id: "mon-am", start: on(19, 8), end: on(19, 10), place: CORVALLIS },
  { id: "mon-pm", start: on(19, 13), end: on(19, 15), place: ALBANY },
  { id: "tue-am", start: on(20, 8), end: on(20, 11), place: CORVALLIS_NE },
];

const week = planGapsByDay(WEEK);
ok(
  "THE POINT: no travel strip is drawn across an overnight",
  week.length === 1 && week[0].fromId === "mon-am" && week[0].toId === "mon-pm",
  JSON.stringify(week.map((g) => `${g.fromId}>${g.toId}`))
);
ok(
  "...whereas the single-day function would have drawn one, which is why this exists",
  planGaps(WEEK).length === 2
);
ok(
  "a day with one job contributes nothing",
  planGapsByDay([WEEK[2]]).length === 0
);
ok(
  "three days each with two jobs give three strips, not five",
  planGapsByDay([
    { id: "a1", start: on(19, 8), end: on(19, 9), place: CORVALLIS },
    { id: "a2", start: on(19, 12), end: on(19, 13), place: CORVALLIS },
    { id: "b1", start: on(20, 8), end: on(20, 9), place: CORVALLIS },
    { id: "b2", start: on(20, 12), end: on(20, 13), place: CORVALLIS },
    { id: "c1", start: on(21, 8), end: on(21, 9), place: CORVALLIS },
    { id: "c2", start: on(21, 12), end: on(21, 13), place: CORVALLIS },
  ]).length === 3
);
// Local days, not UTC ones: a 5pm Pacific job in October is already tomorrow
// in UTC, so grouping on an ISO date string would split a single day in two.
// The fixture only works if the evening job really does fall on the next UTC
// day. Asserted rather than assumed, because if the timezone above ever stops
// taking effect this whole check silently becomes a tautology again.
const evening = on(19, 17);
ok(
  "the timezone this suite needs is actually in force",
  on(19, 9).toISOString().slice(0, 10) !== evening.toISOString().slice(0, 10),
  `9am and 5pm local are ${on(19, 9).toISOString()} and ${evening.toISOString()}`
);
ok(
  "THE POINT: a late-afternoon job stays on its own LOCAL day",
  planGapsByDay([
    { id: "morning", start: on(19, 9), end: on(19, 11), place: CORVALLIS },
    { id: "evening", start: evening, end: on(19, 19), place: CORVALLIS_NE },
  ]).length === 1,
  "grouping on toISOString().slice(0,10) would put these on different days"
);
ok(
  "months apart are never paired",
  planGapsByDay([
    { id: "sep", start: new Date(2026, 8, 30, 9), end: new Date(2026, 8, 30, 11), place: CORVALLIS },
    { id: "oct", start: new Date(2026, 9, 1, 9), end: new Date(2026, 9, 1, 11), place: ALBANY },
  ]).length === 0
);
ok(
  "the routed override survives the day grouping too",
  planGapsByDay(WEEK, (a, b) => (a === "mon-am" && b === "mon-pm" ? 44 : null))[0]
    .gap.minutes === 44
);
ok(
  "an empty calendar does not crash",
  planGapsByDay([]).length === 0 && planGapsByDay().length === 0
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
