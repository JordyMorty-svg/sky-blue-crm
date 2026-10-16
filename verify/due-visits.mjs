// What "To schedule" says about each row, and in what order.
//
//   node verify/due-visits.mjs
//
// ---------------------------------------------------------------------------
// WHY THESE ARE WORTH ASSERTING
// ---------------------------------------------------------------------------
//
// db/quote-accept-job.sql puts a second kind of row into a list that had only
// ever held one. Two things then had to be true, and neither was:
//
//   1. The row has to be VISIBLE. fetchDueVisits filtered `starts_at <=
//      cutoff`, and SQL comparisons exclude nulls — so a job with no date at
//      all was silently absent. Creating the job without fixing that would
//      have moved the work from one place nobody looks to another.
//   2. The row has to say what it IS. Rendered through the recurring card,
//      accepted quote work came out as "Recurring · visit 1 · Due No time
//      set": three claims, two of them false.
//
// The ordering matters for the same reason as the visibility. Postgres sorts
// nulls LAST ascending, so the undated rows — the only ones that can be
// quietly lost — would sit under months of scheduled visits.

import { describeDueVisit, sortDueVisits } from "../src/services/dueVisits.js";

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const QUOTE = {
  id: "q1",
  from_quote_id: "abc",
  price: 1195,
  starts_at: null,
  visit_number: 1,
};
const RECURRING = {
  id: "r1",
  from_quote_id: null,
  price: 420,
  starts_at: "2026-11-02T17:00:00.000Z",
  visit_number: 3,
};

console.log("\n-- telling the two apart --\n");

ok(
  "THE POINT: accepted quote work is not labelled as recurring",
  describeDueVisit(QUOTE).kind === "quote" &&
    describeDueVisit(QUOTE).tag !== describeDueVisit(RECURRING).tag,
  `${describeDueVisit(QUOTE).tag} vs ${describeDueVisit(RECURRING).tag}`
);
ok(
  "...and a real recurring visit still is",
  describeDueVisit(RECURRING).kind === "recurring" &&
    describeDueVisit(RECURRING).tag === "Recurring"
);

// "Due —" reads as something to wait for. They have already said yes.
ok(
  "THE POINT: quote work asks for a date rather than announcing one",
  describeDueVisit(QUOTE).when === "Needs a date",
  describeDueVisit(QUOTE).when
);
ok(
  "a dated recurring visit shows its date",
  /^Due .+\d/.test(describeDueVisit(RECURRING).when),
  describeDueVisit(RECURRING).when
);
ok(
  "...and never the words 'No time set', which is what it used to say",
  !describeDueVisit(QUOTE).when.includes("No time set") &&
    !describeDueVisit(RECURRING).when.includes("No time set")
);

// A recurring visit that somehow lost its date is in the same boat as quote
// work, and should read the same way rather than falling through to "Due ".
ok(
  "THE POINT: a dateless recurring visit is also flagged as needing one",
  describeDueVisit({ ...RECURRING, starts_at: null }).when === "Needs a date" &&
    describeDueVisit({ ...RECURRING, starts_at: null }).needsDate === true
);
ok(
  "a dated one is not",
  describeDueVisit(RECURRING).needsDate === false
);
ok(
  "nothing crashes on a row with no fields at all",
  describeDueVisit({}).kind === "recurring" && describeDueVisit().kind === "recurring"
);

console.log("-- the order of the list --\n");

const soon = { id: "a", starts_at: "2026-10-20T17:00:00.000Z" };
const later = { id: "b", starts_at: "2026-12-01T17:00:00.000Z" };
const undated1 = { id: "c", starts_at: null, from_quote_id: "x" };
const undated2 = { id: "d", starts_at: null, from_quote_id: "y" };

const order = (list) => sortDueVisits(list).map((j) => j.id).join("");

ok(
  "THE POINT: rows with no date come first, not last",
  order([later, soon, undated1]) === "cab",
  order([later, soon, undated1])
);
ok(
  "...whatever order they arrive in",
  order([undated1, later, soon]) === "cab" &&
    order([soon, undated1, later]) === "cab"
);
ok(
  "dated rows are in date order",
  order([later, soon]) === "ab",
  order([later, soon])
);
ok(
  "two undated rows do not throw away either of them",
  order([undated1, later, undated2]).length === 3 &&
    order([undated1, later, undated2]).endsWith("b")
);
ok(
  "the input array is not mutated",
  (() => {
    const input = [later, soon, undated1];
    sortDueVisits(input);
    return input.map((j) => j.id).join("") === "bac";
  })()
);
ok(
  "an empty or missing list is an empty list",
  sortDueVisits([]).length === 0 && sortDueVisits().length === 0
);
ok(
  "an unparseable date does not reorder everything around it",
  sortDueVisits([{ id: "x", starts_at: "not a date" }, soon]).length === 2
);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
