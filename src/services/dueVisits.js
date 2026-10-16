// What a row in "To schedule" says about itself.
//
// Two very different things arrive in that list and until now only one of
// them existed, so the card was written for it: a recurring visit, which has
// a customer, a visit number and a due date computed from the plan.
//
// Accepted quote work (db/quote-accept-job.sql) has none of those. It has a
// price somebody has already agreed to and no date at all. Rendered through
// the recurring card it came out as "Recurring · visit 1 · Due No time set",
// which is three statements and two of them untrue.
//
// NO SUPABASE IMPORT IN THIS FILE, deliberately. jobService.js pulls in
// supabaseClient, which reads `import.meta.env` and therefore cannot be
// imported by a Node test — that is exactly how verify/calendar-layout.mjs
// spent a week dying on load. Putting the words in their own module is what
// makes verify/due-visits.mjs possible, and the whole reason this is a
// module at all rather than six lines inside Jobs.jsx.

/**
 * @param {object} job  a row from fetchDueVisits()
 * @returns {{kind, tag, when, needsDate}}
 *   kind      "quote" | "recurring"
 *   tag       the badge on the card
 *   when      the line under it
 *   needsDate true when nobody has picked a time yet — the ones that should
 *             be at the top of the list, because they are the ones at risk
 *             of being forgotten
 */
export function describeDueVisit(job) {
  const quote = Boolean(job?.from_quote_id);
  const when = job?.starts_at;

  if (quote) {
    return {
      kind: "quote",
      tag: "Accepted quote",
      // Not "Due —". They accepted; the ball is entirely in our court, and
      // the card should read as a thing to do rather than a thing to await.
      when: "Needs a date",
      needsDate: true,
    };
  }

  return {
    kind: "recurring",
    tag: "Recurring",
    when: when ? `Due ${formatWhen(when)}` : "Needs a date",
    needsDate: !when,
  };
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Dateless first, then by date.
 *
 * Done here rather than left to the query's ORDER BY. Postgres sorts nulls
 * last on an ascending sort, so the rows nobody has scheduled — the only
 * ones that can be silently lost — would sit underneath months of dated
 * visits. The server is still asked for the right order; this makes the
 * order a property of the list rather than of a database default, and it is
 * the version a test can check.
 */
export function sortDueVisits(jobs) {
  return [...(jobs || [])].sort((a, b) => {
    const at = a?.starts_at ? Date.parse(a.starts_at) : null;
    const bt = b?.starts_at ? Date.parse(b.starts_at) : null;
    if (at === null && bt === null) return 0;
    if (at === null) return -1;
    if (bt === null) return 1;
    return at - bt;
  });
}
