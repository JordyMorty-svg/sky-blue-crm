// Filling in a customer's address when booking tells us one.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG
// ---------------------------------------------------------------------------
//
// findOrCreateCustomer() matches an existing customer on their phone number
// and, on a match, returns early after updating only `service_plan` and
// `property_type`. The rule it states for those is right:
//
//     "Only ever upgrades away from the defaults: a one-off booking must
//      not silently drop someone off the plan they're already on."
//
// The address was never part of that update. So `customers.address` is
// written exactly once — on the insert branch, at first contact, from
// `lead.address` — and if it was blank then it is blank forever, however
// many jobs get booked afterwards with a perfectly good address on the lead.
//
// On 16 October 2026 that was 69 of 97 jobs resolving to no coordinates, and
// a travel-time feature that had never once been able to ask Google a
// question. The addresses existed the whole time; they were on the leads and
// the jobs, one rung up the ladder from the row everything else reads.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE FILE
// ---------------------------------------------------------------------------
//
// Because jobService.js imports supabaseClient, which reads
// `import.meta.env`, which cannot be imported by a Node test. Every rule
// below would otherwise be untestable — and the last two things in this
// codebase that were untestable for that reason both shipped with bugs in
// them. Same reasoning as dueVisits.js.

/** Trimmed, or null — "" and "   " are both the same thing as no address. */
function clean(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

/** A number, or null. `Number(null)` is 0, which is why this is not inline. */
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * What to write onto a matched customer's address, if anything.
 *
 * @param {object} customer  the existing row, as matched on phone
 * @param {object} source    the lead (or anything carrying address +
 *                           latitude + longitude) the booking came from
 * @returns {null|{address, latitude, longitude}} null means leave it alone
 *
 * THREE RULES, AND THE SECOND IS THE WHOLE POINT:
 *
 * 1. Nothing to copy, nothing happens. A blank source cannot improve on a
 *    blank customer, and writing null over null is a pointless row touch
 *    that bumps them up every "recently changed" list for no reason.
 *
 * 2. A GOOD ADDRESS IS NEVER OVERWRITTEN. Not by a different one, not by a
 *    better-looking one. The customer record is the maintained one —
 *    somebody keeps it right — and a booking is one person typing one thing
 *    once. This function fills a hole; it does not have opinions. It is also
 *    what makes the change safe to run against every booking rather than
 *    needing a migration: the worst it can do is nothing.
 *
 * 3. COORDINATES TRAVEL WITH THE ADDRESS THEY BELONG TO, both or neither.
 *    jobAddress.js refuses to mix them for a reason worth repeating here:
 *    doing so "sends the van to the wrong house with the right street name
 *    printed on the screen, which is worse than arriving with no pin at all
 *    — the driver trusts the map and stops reading." A source with an
 *    address and no pin therefore writes the address and two nulls, rather
 *    than leaving whatever stale coordinates were sitting in the columns.
 */
export function addressFillForMatch(customer, source) {
  if (clean(customer?.address) !== null) return null;

  const address = clean(source?.address);
  if (address === null) return null;

  return {
    address,
    latitude: num(source?.latitude),
    longitude: num(source?.longitude),
  };
}

/**
 * The guard that makes the write safe against a second booking landing at
 * the same moment.
 *
 * Returns the filter to apply to the UPDATE so it matches zero rows if
 * anybody has filled the address in since it was read. Optimistic
 * concurrency on the one column being changed, which is cheaper and clearer
 * than a lock and cannot deadlock with the property-sync trigger.
 *
 * `is null` and `eq ""` are different filters in PostgREST, and a customer
 * row can hold either — null from the insert branch's `lead.address || null`,
 * whitespace from somebody editing the profile by hand. Guarding on the
 * value actually read covers both without caring which.
 */
export function blankAddressGuard(customer) {
  return customer?.address === null || customer?.address === undefined
    ? { kind: "is-null" }
    : { kind: "equals", value: customer.address };
}
