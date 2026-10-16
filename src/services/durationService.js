// How long a job should be booked for, and how much road sits between two of
// them.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// Every scheduling screen defaulted to three hours. `useState(3)` in five
// components and `|| 3` in eight more. That number was right in July, when the
// work was exterior-only on smaller houses, and it quietly stopped being right
// as the jobs got bigger — which is the worst kind of wrong, because every
// individual estimate looks like the last one that worked.
//
// Measured on 14 October 2026 against every completed job with a real
// `starts_at` and `completed_at`:
//
//     flat 3 h covered 10 of 25 window jobs.
//     The crew ran past the booked time on 15 of 25 — 60% of the time.
//     The worst overrun was 4.3 h, on an $800 job that took 7.3.
//
// On 13 October that arithmetic turned into a customer standing on his porch
// waiting, which is what this module is really about.
//
// ---------------------------------------------------------------------------
// WHY PRICE, AND WHAT PRICE CANNOT TELL YOU
// ---------------------------------------------------------------------------
//
// The price already encodes the size of the job — that is what a per-window
// quote is. So the hours come off the price rather than being guessed a second
// time by a different person at a different moment.
//
// It is a good default and it is not a prediction. Across the 25 jobs, price
// explains about a THIRD of the variation in hours (r² = 0.35). Two jobs at
// the same price came in at 1.6 h and 4.7 h. That is expected: price tracks
// window count, while time tracks access, grime, interiors, and how much the
// customer wants to chat — and at a flat $5 a window, an awkward one over a
// hedge prices the same as an easy one at waist height.
//
// So this fills the field in. It does not lock it. A human who has seen the
// house still beats it and must always be able to say so.
//
// ---------------------------------------------------------------------------
// WHY THE DIVISOR IS NOT THE MEASURED RATE
// ---------------------------------------------------------------------------
//
// The measured rate for residential window work is $135 per crew-hour. The
// rule below divides by $150, which is deliberate and is the whole trick.
//
// Booking the *average* job puts you late half the time by construction. The
// fitted line through the data (1.25 h + price ÷ $206) lifts coverage from 40%
// only to 56%. What buys the coverage is the flat setup term on the front:
//
//     rule                     covered          worst overrun left
//     flat 3 h                 10/25   40%      4.3 h
//     1.25 + price/206 (fit)   14/25   56%      2.2 h
//     1.0  + price/150         19/25   76%      1.7 h
//     1.5  + price/150         20/25   80%      1.2 h     <-- chosen
//     1.5  + price/125         24/25   96%      0.8 h
//
// 1.5 + price/150 is the knee. The one job in five that still overruns does so
// by about an hour rather than four. Going on to 1.5 + price/125 buys another
// 16 points of coverage and books an extra 45 hours of empty calendar across
// the same 25 jobs — most of a working week.
//
// If you change a number in RULES, re-run `node verify/job-duration.mjs`: the
// coverage figures above are asserted there against the real jobs, so the
// table cannot rot into a comment that used to be true.

/* ---------------------------------------------------------------------------
 * The calibration
 * ------------------------------------------------------------------------ */

/**
 * One rule per service, keyed by the slugs in SERVICE_TYPES (leadService.js).
 *
 * `setup`   flat hours on the front: unloading, filling, poles out, packing
 *           up, and the walk-around with the customer. It does not scale with
 *           the house and it is always there.
 * `per`     dollars of ticket per additional hour.
 * `n`       how many real jobs this was fitted to. Read it before trusting it.
 */
export const RULES = {
  // 25 jobs, 31 Aug – 13 Oct 2026. Measured $135/crew-hour; see the header for
  // why the divisor is 150 and not 135.
  "residential-window-washing": { setup: 1.5, per: 150, n: 25 },

  // 4 jobs, and they disagree with each other violently: $350 took 1.1 h and
  // $400 took 3.2 h. Gutter work is genuinely bimodal — a ground-level ranch
  // is quick, and the 1.1 h job was fast because it was gutter guards reached
  // on a belay, which is dangerous rather than slow.
  //
  // A four-point fit is a guess with a decimal point on it. This one covers
  // all four and is the least-confident number in the file; revisit it the
  // moment there are a dozen gutter jobs to fit.
  "gutter-cleaning": { setup: 1.0, per: 175, n: 4 },
};

/**
 * Services with no completed jobs behind them yet: commercial, screens,
 * pressure washing, solar. They borrow the residential window rule rather than
 * getting an invented one of their own — it is the more generous of the two
 * measured rules, and over-booking an unknown is the cheaper mistake.
 */
export const FALLBACK_RULE = RULES["residential-window-washing"];

/**
 * What to show for a job whose `duration_hours` is null — rows booked before
 * this module existed. It is NOT a suggestion for a new job; it is "we do not
 * know what was booked here", and three hours is what was most likely meant at
 * the time.
 *
 * Everywhere that used to write `|| 3` inline imports this instead, so there
 * is one place to change it and no chance of two screens disagreeing.
 */
export const FALLBACK_HOURS = 3;

/** Nothing on site is shorter than this, whatever the arithmetic says. */
export const MIN_HOURS = 1;

/**
 * Past this, it is not a long job, it is two days — and the calendar should
 * say so before anyone promises otherwise. The $3,280 Krueger job ran 34.3
 * hours of wall clock because it spanned two days.
 */
export const MAX_SINGLE_DAY_HOURS = 8;

/* ---------------------------------------------------------------------------
 * The estimate
 * ------------------------------------------------------------------------ */

/**
 * Round UP to the nearest half hour.
 *
 * Up, not nearest, and that is a decision rather than an oversight: the input
 * steps in halves, and the failure this module exists to fix is under-booking.
 * Rounding up can only raise the coverage numbers in the header table.
 */
function ceilHalf(hours) {
  return Math.ceil(hours * 2) / 2;
}

/**
 * Pick the rule for a job that is several services at once.
 *
 * A $1,180 job that is windows AND gutters has one price covering both, so
 * there is no honest way to split it. Taking the rule that yields the LONGER
 * block is the conservative read, and it means adding a service to a job can
 * never shorten it — which would be nonsense on screen.
 */
function ruleFor(serviceKeys, price) {
  const keys = Array.isArray(serviceKeys) ? serviceKeys : [];
  const rules = keys.map((k) => RULES[k] || FALLBACK_RULE);
  if (rules.length === 0) return FALLBACK_RULE;
  return rules.reduce((longest, r) =>
    r.setup + price / r.per > longest.setup + price / longest.per ? r : longest
  );
}

/**
 * The suggested block for a job, in hours.
 *
 * @param {object}   job
 * @param {number}   job.price         the quoted ticket, in dollars
 * @param {string[]} job.serviceKeys   SERVICE_TYPES slugs
 * @returns {number|null} hours, rounded up to the half; null when there is no
 *   price to work from, because an estimate built on a missing number is worse
 *   than an empty field — an empty field asks the question out loud.
 */
export function suggestDuration({ price, serviceKeys } = {}) {
  const amount = num(price);
  if (amount === null || amount <= 0) return null;

  const rule = ruleFor(serviceKeys, amount);
  return Math.max(MIN_HOURS, ceilHalf(rule.setup + amount / rule.per));
}

/**
 * A sentence explaining where the number came from, for the hint under the
 * field. A default nobody can interrogate is a default nobody trusts, and the
 * first question anyone asks of an auto-filled number is "says who".
 */
export function explainDuration({ price, serviceKeys } = {}) {
  const hours = suggestDuration({ price, serviceKeys });
  if (hours === null) return "Add a price and this fills itself in.";

  const amount = Number(price);
  const rule = ruleFor(serviceKeys, amount);
  const thin = rule.n < 10 ? ` Fitted to only ${rule.n} jobs so far.` : "";
  const long =
    hours > MAX_SINGLE_DAY_HOURS
      ? " That is more than a day — consider splitting it across two."
      : "";

  return (
    `${hours} h suggested: ${rule.setup} h setup and travel, ` +
    `plus an hour per $${rule.per} of the $${Math.round(amount)} ticket.` +
    `${thin}${long}`
  );
}

/** True when the suggestion has outgrown a single working day. */
export function exceedsOneDay(hours) {
  return Number(hours) > MAX_SINGLE_DAY_HOURS;
}

/* ---------------------------------------------------------------------------
 * Travel between jobs
 * ------------------------------------------------------------------------ */

/**
 * The gap the crew needs between finishing one job and starting the next.
 *
 * This is a GAP, not padding inside a job. Two reasons, and the second is the
 * one that matters: a block that is 15 minutes longer than the work would
 * quietly inflate `completed_at - starts_at`, which is the exact measurement
 * this whole module is calibrated from. Padding the jobs would poison the next
 * recalibration.
 */
export const LOCAL_TRAVEL_MINUTES = 15;
export const DISTANT_TRAVEL_MINUTES = 30;

/**
 * Added on top of a REAL routed drive, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A FLOOR
 * ---------------------------------------------------------------------------
 *
 * The first version floored every routed drive at LOCAL_TRAVEL_MINUTES, on
 * the sound reasoning that a gap is not only driving: it is the tail of one
 * job running late, a customer with one more question at the door, and
 * parking at the other end.
 *
 * Sound, and wrong in practice, because Corvallis is six miles across. Every
 * in-town drive comes in under fifteen minutes, so every in-town gap read as
 * exactly fifteen — the same number the straight-line fallback produces, and
 * the same number shown when nothing was ever sent to Google. The routing
 * could have been working perfectly for a week and looked identical to not
 * working at all. It was, and it did.
 *
 * A floor also scales the wrong way: it protects a four-minute hop with
 * eleven minutes of slack and a twenty-six-minute run to Albany with none.
 * The slack a job needs has nothing to do with how short the drive was.
 *
 * So the slack is additive and the drive is reported as measured. Seven
 * minutes of road books seventeen; Albany books thirty-six.
 *
 * ESTIMATES ARE NOT PADDED. The straight-line tiers below are already
 * generous round numbers standing in for an unknown — adding ten to a guess
 * makes a bigger guess, not a safer one, and would put the estimate above
 * the measured answer for the same pair.
 */
export const TRAVEL_BUFFER_MINUTES = 10;

/**
 * Past this, it is another town. Corvallis to Albany is about 11 miles door to
 * door, so 8 keeps the whole of Corvallis local and puts Albany, Philomath and
 * the outer valley on the longer gap.
 */
export const DISTANT_MILES = 8;

/**
 * A number, or null — where null, undefined and "" are all null.
 *
 * This exists because `Number(null)` is 0 and `Number("")` is 0, both of them
 * perfectly finite. A plain `Number.isFinite(Number(x))` guard therefore
 * accepts a missing latitude as the equator and a missing drive time as an
 * instant teleport, and both of those read as success. The first draft of
 * this file had exactly that bug in two places and verify/job-duration.mjs
 * found it on its first run.
 */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Great-circle miles between two {latitude, longitude} points. */
export function milesBetween(a, b) {
  const lat1 = num(a?.latitude);
  const lon1 = num(a?.longitude);
  const lat2 = num(b?.latitude);
  const lon2 = num(b?.longitude);
  if ([lat1, lon1, lat2, lon2].some((v) => v === null)) return null;

  const R = 3958.8; // Earth's radius in miles
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Minutes of travel to reserve between two jobs.
 *
 * @param {object} fromJob  anything carrying {latitude, longitude}
 * @param {object} toJob    likewise
 * @param {number|null} drivenMinutes  a real routed drive time, when one has
 *   been fetched (see driveTimeService.js). Null when it has not.
 * @returns {{minutes, miles, basis}} where basis is one of:
 *   "driven"   a real route, floored at the local minimum
 *   "distance" straight-line distance decided it
 *   "assumed"  one of the two jobs has no saved coordinates
 *
 * `basis` is returned rather than swallowed so the screen can say where the
 * number came from. Stating "15 minutes" as a fact when nobody knows the
 * address is how a schedule earns trust it has not got — and that trust is
 * precisely what ran out on the porch in Albany.
 *
 * THE LOCAL GAP IS A FLOOR, NOT A DEFAULT. A routed six-minute hop across
 * Corvallis still gets 15 minutes, because the gap is not only driving: it is
 * the tail of one job running late, a customer with one more question at the
 * door, and finding somewhere to park at the other end.
 */
export function travelGap(fromJob, toJob, drivenMinutes = null) {
  const miles = milesBetween(fromJob, toJob);

  const driven = num(drivenMinutes);
  if (driven !== null && driven >= 0) {
    const drive = Math.ceil(driven);
    return {
      minutes: drive + TRAVEL_BUFFER_MINUTES,
      // Kept apart so the screen can say "7 min drive + 10 min" rather than
      // presenting a padded number as though Google had measured it.
      drive,
      buffer: TRAVEL_BUFFER_MINUTES,
      miles,
      basis: "driven",
    };
  }

  if (miles === null) {
    return {
      minutes: LOCAL_TRAVEL_MINUTES,
      drive: null,
      buffer: 0,
      miles: null,
      basis: "assumed",
    };
  }

  return {
    minutes: miles > DISTANT_MILES ? DISTANT_TRAVEL_MINUTES : LOCAL_TRAVEL_MINUTES,
    drive: null,
    buffer: 0,
    miles,
    basis: "distance",
  };
}

/**
 * The few characters that fit on a travel strip.
 *
 * A TILDE MEANS NOBODY MEASURED IT. The strip only has room for a number,
 * and three completely different states were all rendering as "15m": a real
 * routed drive that came in under the floor, a straight-line estimate
 * between two Corvallis addresses, and a pair where one job has no
 * coordinates at all so nothing was ever asked. Jordan spent two days
 * reasonably assuming a broken API key, because the screen gave him no way
 * to tell those apart — and 15 is what the first two legitimately produce
 * for almost every job in a town this size.
 *
 * One character fixes it. "27m" was driven; "~15m" was guessed.
 */
export function gapLabel(gap) {
  if (!gap) return "";
  return `${gap.basis === "driven" ? "" : "~"}${gap.minutes}m`;
}

/** A short phrase for the screen: "27 min drive", "15 min (assumed)". */
export function describeGap(gap) {
  if (!gap) return "";
  if (gap.basis === "driven") {
    return `${gap.drive} min drive + ${gap.buffer} min to pack up and park`;
  }
  // NOT "no address on file", which is what this said first and which is
  // usually a lie. jobAddress() resolves the address off whichever row has
  // one — the lead, or the frozen job — but takes the COORDINATES from that
  // same row and nowhere else, on purpose: borrowing a pin from a lower rung
  // "sends the van to the wrong house with the right street name printed on
  // the screen". So the normal state here is a job showing a complete
  // address and carrying no pin, and Jordan quite reasonably read the old
  // wording as the CRM having lost an address he could see on the screen.
  if (gap.basis === "assumed") {
    return `${gap.minutes} min — estimated, one of these has no map pin`;
  }
  return `${gap.minutes} min (${gap.miles.toFixed(1)} mi away)`;
}

/**
 * When a job ends, the moment the crew could realistically start the next one.
 */
export function readyAfter(endDate, gapMinutes) {
  return new Date(endDate.getTime() + gapMinutes * 60000);
}

/** When a job starts, the latest a previous job could have finished. */
export function mustFinishBy(startDate, gapMinutes) {
  return new Date(startDate.getTime() - gapMinutes * 60000);
}

/**
 * The travel strips for a whole day, between each stop and the one AFTER it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION AND NOT A LOOP IN THE VIEW
 * ---------------------------------------------------------------------------
 *
 * It was a loop in the view for about an hour, and it was wrong in a way that
 * looked right. DayPreview drew a strip after every existing job and set each
 * one to `travelGap(thatJob, theJobBeingBooked)` — so with one job already on
 * the day it was correct, and with two it labelled the strip after the 9am
 * job with the drive to the 3pm job being booked, while sitting directly
 * underneath the 11am one.
 *
 * A number in the wrong place is worse than no number. The fix is to decide
 * the pairs from the timeline rather than from which job happens to be under
 * the cursor, and that decision is logic, so it lives here where it can be
 * tested.
 *
 * @param {Array<{id, start: Date, end: Date, place}>} stops  one per job,
 *   in any order — this sorts them.
 * @param {(fromId, toId) => number|null} [drivenLookup]  real routed minutes
 *   for a pair, when they have been fetched.
 * @returns {Array<{fromId, toId, at: Date, gap, tight: boolean}>} one entry
 *   per consecutive pair THAT HAS A BETWEEN. `at` is when the first job
 *   ends, which is where the strip is drawn. `tight` is true when the next
 *   job starts before the gap has elapsed — the thing that put a customer on
 *   his porch.
 *
 * A PAIR THAT OVERLAPS GETS NO ENTRY. Two jobs booked over each other have
 * no road between them; they have a double-booking, which the conflict
 * warnings and the overlapping blocks already say plainly. Emitting a gap
 * anyway put a red strip at the END of the first job — 12:00 — on a pair
 * whose second job had started at 11:00. It was not even wrong about there
 * being a problem; it was pointing an hour away from it.
 *
 * Found by rendering the week grid and looking at it. Nothing in the data
 * said anything was amiss, because nothing had been asked to.
 */
export function planGaps(stops, drivenLookup = () => null) {
  const ordered = [...(stops || [])]
    .filter((s) => s && s.start instanceof Date && s.end instanceof Date)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = ordered[i];
    const to = ordered[i + 1];
    // No between, nothing to draw. See the note above.
    if (to.start < from.end) continue;

    const gap = travelGap(from.place, to.place, drivenLookup(from.id, to.id));
    out.push({
      fromId: from.id,
      toId: to.id,
      at: from.end,
      gap,
      // Strictly less than: arriving exactly as the gap runs out is fine,
      // arriving a minute later is not.
      tight: to.start < readyAfter(from.end, gap.minutes),
    });
  }
  return out;
}

/**
 * planGaps() applied to a calendar, one day at a time.
 *
 * THE DAY BOUNDARY IS THE WHOLE POINT. Handing a month of jobs straight to
 * planGaps() produces a "gap" between the last job on Monday and the first on
 * Tuesday — fifteen minutes of travel drawn across an overnight, and on a
 * week grid it would render as a strip hanging off the bottom of one column
 * with nothing to do with the next. Nobody drives home and back inside the
 * gap; they go to bed.
 *
 * Grouped by LOCAL calendar day rather than by a UTC date string, because the
 * crew's Monday is Pacific time and a 5pm job in October is already Tuesday
 * in UTC.
 *
 * @param {Array<{id, start: Date, end: Date, place}>} stops  any order, any
 *   number of days
 * @param {(fromId, toId) => number|null} [drivenLookup]
 * @returns {Array} the same shape planGaps() returns, for every day at once
 */
export function planGapsByDay(stops, drivenLookup = () => null) {
  const byDay = new Map();
  for (const s of stops || []) {
    if (!s || !(s.start instanceof Date) || !(s.end instanceof Date)) continue;
    const key = `${s.start.getFullYear()}-${s.start.getMonth()}-${s.start.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }

  const out = [];
  for (const day of byDay.values()) out.push(...planGaps(day, drivenLookup));
  return out;
}
