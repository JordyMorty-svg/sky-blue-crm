/*
 * Where is this job?
 *
 * ONE ANSWER, AND IT MATCHES THE DATABASE. public.sb_job_address() in
 * db/properties.sql resolves this server-side for reports and for anything
 * SQL needs; this file is the same ladder for the screens, which already
 * hold the joined rows and should not make a round trip to ask where the
 * job they are rendering is.
 *
 * THE TWO MUST NOT DRIFT. verify/job-address.mjs checks this file against
 * the same cases verify/properties.sql puts through the SQL, so a change to
 * one that is not made to the other fails rather than producing a CRM where
 * the invoice and the screen disagree about which house you cleaned.
 *
 * WHY THIS FILE EXISTS AT ALL. Before it, eleven places resolved a job's
 * address inline and they did not agree:
 *
 *   JobDetail.jsx      lead?.address || customer?.address
 *   JobRecord.jsx      customer?.address || lead?.address
 *   ConfirmVisit.jsx   customer?.address || lead?.address
 *   taxService.js      customer?.address || lead?.address
 *   navigation.js      customer?.address || lead?.address
 *
 * For any customer whose address had ever been corrected, the job detail
 * page and the job record showed different addresses for the same job, and
 * neither of them looked wrong. Nobody reported it because nobody had both
 * screens open at once.
 */

// Trimmed, or null. An address of "" and an address of "   " are both the
// same thing as no address, and the difference between them is whichever
// screen last wrote the row.
function clean(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

/**
 * The address a job is at, and the coordinates of that same place.
 *
 * Expects a job row joined with `property`, `customer` and `lead` — see the
 * selects in jobService.js. Missing joins are fine; the ladder just starts
 * further down.
 *
 * @returns {{address: string|null, latitude: number|null, longitude: number|null, source: string|null}}
 */
export function jobAddress(job) {
  // THE ORDER IS THE WHOLE FILE. Each rung, and why it is above the next:
  const rungs = [
    // 1. FROZEN. Written by the jobs_freeze_address trigger when the job
    //    completed. A finished job's address is a historical fact and
    //    outranks every live record, including a customer who has since
    //    moved house. Without this, last year's invoices relocate.
    ["job", job],
    // 2. The property this visit was booked at. The reason any of this
    //    exists: one customer, a model home and the house they live in.
    ["property", job?.property],
    // 3. The customer. The maintained record — somebody keeps it right.
    ["customer", job?.customer],
    // 4. The lead. A snapshot of what one person typed into a form once,
    //    and last for that reason. Reached only by a job booked straight
    //    off a lead before a customer row existed.
    ["lead", job?.lead],
  ];

  for (const [source, row] of rungs) {
    const address = clean(row?.address);
    if (!address) continue;

    // COORDINATES COME FROM THE ROW THE ADDRESS CAME FROM, never from the
    // next one down. Mixing them sends the van to the wrong house with the
    // right street name printed on the screen, which is worse than arriving
    // with no pin at all — the driver trusts the map and stops reading.
    return {
      address,
      latitude: row?.latitude ?? null,
      longitude: row?.longitude ?? null,
      source,
    };
  }

  return { address: null, latitude: null, longitude: null, source: null };
}

/**
 * Just the text, for the many places that only print it.
 *
 * Takes its own fallback so each caller keeps the wording it already had —
 * "No address" on the job screens, "" where it feeds a maps URL.
 */
export function jobAddressText(job, fallback = "") {
  return jobAddress(job).address ?? fallback;
}

/**
 * Is this job's address settled for good?
 *
 * True once the freeze trigger has run. The job screens use it to explain
 * why the address can be changed on an upcoming visit and not on a finished
 * one — a disabled control with no reason beside it reads as a bug.
 */
export function addressIsFrozen(job) {
  return clean(job?.address) !== null;
}
