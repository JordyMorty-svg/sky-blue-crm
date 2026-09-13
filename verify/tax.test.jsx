/**
 * The tax export, where being wrong is expensive in a way the rest of the
 * CRM isn't.
 *
 * Two failures are worth more than all the others put together:
 *
 *   1. Counting a payout in the wrong calendar year. A 1099-NEC reports cash
 *      that left the business inside the year. Using earned_at instead of
 *      paid_at would file December's fee under the wrong year, and the
 *      contractor's return would then disagree with the IRS's copy.
 *
 *   2. The $600 threshold landing on the wrong side of the boundary. Exactly
 *      $600 requires a form; $599.99 does not.
 *
 * After that: a CSV that a spreadsheet reads back as something other than
 * what went in — an unescaped comma in an address shifting every column
 * right, or a leading "-" in a note evaluating as a formula.
 */
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/context/auth-context";
import {
  INCOME_COLUMNS,
  NEC_THRESHOLD,
  PAYOUT_COLUMNS,
  REP_COLUMNS,
  availableYears,
  chargedAmount,
  incomeRows,
  isoDate,
  monthlyIncome,
  payoutRows,
  payoutsByRep,
  repCsvRows,
  summariseIncome,
  toCsv,
  yearOf,
} from "../src/services/taxService";
import TaxExport from "../src/pages/income/TaxExport";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

// --- 1. CSV correctness ---------------------------------------------------

const COLS = [
  { key: "a", label: "A" },
  { key: "b", label: "B" },
];

check(
  "header comes from the column labels, in column order",
  toCsv(COLS, []).split("\r\n")[0] === "A,B"
);

check(
  "a comma inside a value is quoted, not left to split the row",
  toCsv(COLS, [{ a: "123 Main St, Corvallis", b: "1" }]).includes(
    '"123 Main St, Corvallis",1'
  ),
  toCsv(COLS, [{ a: "123 Main St, Corvallis", b: "1" }])
);

check(
  "an embedded quote is doubled",
  toCsv(COLS, [{ a: 'the "big" house', b: "1" }]).includes(
    '"the ""big"" house"'
  )
);

check(
  "a newline inside a value stays inside one quoted field",
  toCsv(COLS, [{ a: "line one\nline two", b: "1" }]).includes(
    '"line one\nline two"'
  )
);

// The injection case. A note beginning with = or - is a formula to Excel and
// Sheets, and these fields are typed by whoever added the lead.
for (const lead of ["=", "+", "-", "@"]) {
  const out = toCsv(COLS, [{ a: `${lead}cmd`, b: "1" }]);
  check(
    `a value starting with "${lead}" is defused`,
    out.includes(`'${lead}cmd`),
    out
  );
}

check(
  "a normal value is left completely alone",
  toCsv(COLS, [{ a: "Hayden", b: "42" }]).includes("\r\nHayden,42")
);

check(
  "null and undefined become empty cells, not the strings",
  toCsv(COLS, [{ a: null, b: undefined }]).includes("\r\n,\r\n")
);

check(
  "a missing key is an empty cell rather than throwing",
  toCsv(COLS, [{ a: "x" }]).includes("\r\nx,\r\n")
);

check("rows are CRLF-terminated for Windows", toCsv(COLS, []).endsWith("\r\n"));

// --- 2. Dates -------------------------------------------------------------

check("isoDate is sortable YYYY-MM-DD", isoDate("2026-03-07T18:30:00Z").length === 10);
check("a null date is an empty string, not 'Invalid Date'", isoDate(null) === "");
check("garbage in gives empty out", isoDate("not a date") === "" && yearOf("nope") === null);

// The local-year boundary. A job finished at 5pm on Dec 31 in Oregon is
// already Jan 1 in UTC; filing it under the next year would move revenue
// across a tax year.
const NYE = new Date(2025, 11, 31, 17, 0, 0).toISOString();
check(
  "a New Year's Eve evening job counts in the local year, not the UTC one",
  yearOf(NYE) === 2025,
  String(yearOf(NYE))
);

// --- 3. Revenue -----------------------------------------------------------

check("charged prefers the final price over the quote",
  chargedAmount({ price: 400, final_price: 550 }) === 550);
check("...and falls back to the quote when there was no upsell",
  chargedAmount({ price: 400, final_price: null }) === 400);
check("a job with neither is zero, not NaN",
  chargedAmount({}) === 0);
// An upsell DOWN is still the real number. Rounding it back up to the quote
// would overstate income.
check("a discount is honoured, not ignored",
  chargedAmount({ price: 400, final_price: 350 }) === 350);

const JOBS = [
  { id: "j1", starts_at: new Date(2026, 0, 15, 9).toISOString(), price: 400, final_price: 500, paid: true, payment_method: "card", customer: { name: "Ann" } },
  { id: "j2", starts_at: new Date(2026, 5, 2, 9).toISOString(), price: 600, final_price: null, paid: true, payment_method: "cash", lead: { name: "Bob" } },
  // Completed but never collected — a receivable, and it must not silently
  // count as income on a cash-basis return.
  { id: "j3", starts_at: new Date(2026, 5, 20, 9).toISOString(), price: 300, final_price: 300, paid: false, customer: { name: "Cass" } },
  // Different year: must not appear at all.
  { id: "j4", starts_at: new Date(2025, 8, 1, 9).toISOString(), price: 900, final_price: 900, paid: true, customer: { name: "Dee" } },
];

const rows26 = incomeRows(JOBS, 2026);
check("only the selected year's jobs are exported", rows26.length === 3, String(rows26.length));
check("the prior year is excluded", !rows26.some((r) => r.customer === "Dee"));
check("a job with no customer falls back to the lead name",
  rows26.find((r) => r.job_id === "j2").customer === "Bob");

const sum26 = summariseIncome(rows26);
check("collected is the paid jobs only",
  sum26.collected === 1100, String(sum26.collected));
check("an uncollected completed job is shown separately",
  sum26.outstanding === 300, String(sum26.outstanding));
check("gross is both together", sum26.gross === 1400);
check("the job count includes the uncollected one", sum26.jobs === 3);

const months = monthlyIncome(rows26);
check("January's bucket holds January's money", months[0].collected === 500);
check("June holds only what was collected in June",
  months[5].collected === 600, String(months[5].collected));
check("...and still counts the uncollected job",
  months[5].jobs === 2, String(months[5].jobs));
check("an empty month is zero, not missing", months[2].collected === 0 && months.length === 12);

check("every income column has a key present on a real row",
  INCOME_COLUMNS.every((c) => c.key in rows26[0]),
  INCOME_COLUMNS.filter((c) => !(c.key in rows26[0])).map((c) => c.key).join(","));

// --- 4. Payouts, and the year they land in --------------------------------

const T = { id: "p-tre", full_name: "Trenton", role: "partner" };
const M = { id: "p-mar", full_name: "Marcus", role: "tech" };

const PAID = [
  // THE case. Earned in December 2025, cash handed over in January 2026 —
  // belongs on the 2026 form.
  { id: "c1", kind: "find", rate: 15, base_amount: 800, amount: 120, status: "paid",
    earned_at: new Date(2025, 11, 20).toISOString(),
    paid_at: new Date(2026, 0, 8).toISOString(),
    profile: T, lead: { name: "Ann" } },
  { id: "c2", kind: "work", rate: 20, base_amount: 1000, amount: 200, status: "paid",
    earned_at: new Date(2026, 2, 1).toISOString(),
    paid_at: new Date(2026, 2, 5).toISOString(),
    profile: T, job: { starts_at: new Date(2026, 2, 1).toISOString(), visit_number: 2, customer: { name: "Bob" } } },
  { id: "c3", kind: "book", rate: 10, base_amount: 3000, amount: 300, status: "paid",
    earned_at: new Date(2026, 3, 1).toISOString(),
    paid_at: new Date(2026, 3, 2).toISOString(),
    profile: T, lead: { name: "Cass" } },
  // Marcus, deliberately just under the threshold.
  { id: "c4", kind: "work", rate: 20, base_amount: 2999.5, amount: 599.99, status: "paid",
    earned_at: new Date(2026, 4, 1).toISOString(),
    paid_at: new Date(2026, 4, 1).toISOString(),
    profile: M, lead: { name: "Eve" } },
  // Paid in a different year entirely.
  { id: "c5", kind: "find", rate: 15, base_amount: 500, amount: 75, status: "paid",
    earned_at: new Date(2025, 5, 1).toISOString(),
    paid_at: new Date(2025, 5, 3).toISOString(),
    profile: T, lead: { name: "Fay" } },
];

const pay26 = payoutRows(PAID, 2026);
check("a fee earned in December and paid in January lands in the paying year",
  pay26.some((r) => r.commission_id === "c1"), "c1 missing from 2026");
check("...and does NOT appear in the year it was earned",
  !payoutRows(PAID, 2025).some((r) => r.commission_id === "c1"));
check("a payout made in a prior year stays there",
  payoutRows(PAID, 2025).some((r) => r.commission_id === "c5")
    && !pay26.some((r) => r.commission_id === "c5"));
check("both dates are kept on the row so the difference is auditable",
  pay26.find((r) => r.commission_id === "c1").earned_on === "2025-12-20"
    && pay26.find((r) => r.commission_id === "c1").paid_on === "2026-01-08");
check("a repeat visit is labelled in the subject",
  pay26.find((r) => r.commission_id === "c2").subject === "Bob (visit 2)",
  pay26.find((r) => r.commission_id === "c2").subject);
check("every payout column has a key present on a real row",
  PAYOUT_COLUMNS.every((c) => c.key in pay26[0]),
  PAYOUT_COLUMNS.filter((c) => !(c.key in pay26[0])).map((c) => c.key).join(","));

const reps26 = payoutsByRep(pay26);
const trenton = reps26.find((r) => r.rep === "Trenton");
const marcus = reps26.find((r) => r.rep === "Marcus");

check("a rep's payments are summed across the year",
  trenton.total === 620, String(trenton.total));
check("the payment count is right", trenton.payments === 3);
check("first and last payment bracket the year",
  trenton.first_paid === "2026-01-08" && trenton.last_paid === "2026-04-02");
check("over the threshold means a 1099 is required", trenton.needs_1099 === true);
check("a cent under the threshold does not",
  marcus.needs_1099 === false, String(marcus.total));
check("reps are listed highest-paid first", reps26[0].rep === "Trenton");
check("someone paid under the threshold is still listed, not hidden",
  reps26.length === 2);

// Exactly $600. The statute is "$600 or more", so this side of the boundary
// requires a form — the commonest place to get a threshold wrong.
const exact = payoutsByRep([
  { profile_id: "x", rep: "Edge", role: "tech", paid_on: "2026-02-02", amount: "600.00" },
]);
check(`exactly $${NEC_THRESHOLD} requires a 1099`, exact[0].needs_1099 === true);

// A reversal carries a negative amount, so a clawback paid back inside the
// year reduces that year's reported total rather than being counted twice.
const withReversal = payoutsByRep([
  { profile_id: "y", rep: "Nev", role: "tech", paid_on: "2026-02-02", amount: "700.00" },
  { profile_id: "y", rep: "Nev", role: "tech", paid_on: "2026-03-02", amount: "-200.00" },
]);
check("a reversal nets against the total rather than adding to it",
  withReversal[0].total === 500, String(withReversal[0].total));
check("...and can take someone back under the threshold",
  withReversal[0].needs_1099 === false);

check("floating-point crumbs are rounded away",
  payoutsByRep([
    { profile_id: "z", rep: "Cent", role: "tech", paid_on: "2026-01-01", amount: "0.10" },
    { profile_id: "z", rep: "Cent", role: "tech", paid_on: "2026-01-02", amount: "0.20" },
  ])[0].total === 0.3);

const repCsv = repCsvRows(reps26);
check("the CSV spells the flag out for a human",
  repCsv.find((r) => r.rep === "Trenton").needs_1099 === "YES"
    && repCsv.find((r) => r.rep === "Marcus").needs_1099 === "no");
check("every rep column has a key present on a real row",
  REP_COLUMNS.every((c) => c.key in repCsv[0]),
  REP_COLUMNS.filter((c) => !(c.key in repCsv[0])).map((c) => c.key).join(","));

// --- 5. Year picker -------------------------------------------------------

const yrs = availableYears(JOBS, PAID);
check("years come from both jobs and payouts", yrs.includes(2025) && yrs.includes(2026));
check("years are newest first", yrs[0] >= yrs[yrs.length - 1]);
check("the current year is always offered even with no data yet",
  availableYears([], []).includes(new Date().getFullYear()));

// --- 6. The page itself ---------------------------------------------------

const fake = globalThis.__supabaseFake;

function renderPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const value = {
    session: { user: { id: "u1" } },
    user: { id: "u1", email: "jordan@example.com" },
    profile: { full_name: "Jordan", role: "admin" },
    role: "admin",
    isAdmin: true,
    loading: false,
    signOut: () => {},
  };
  act(() => {
    root.render(
      <StrictMode>
        <AuthContext.Provider value={value}>
          <MemoryRouter initialEntries={["/income/tax"]}>
            <TaxExport />
          </MemoryRouter>
        </AuthContext.Provider>
      </StrictMode>
    );
  });
  return {
    host,
    text: () => host.textContent,
    click: (sel, i = 0) => {
      const nodes = [...host.querySelectorAll(sel)];
      act(() => nodes[i].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    },
    findButton: (label) =>
      [...host.querySelectorAll("button")].find((b) =>
        b.textContent.includes(label)
      ),
    done: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

fake.__setJobs(JOBS);
fake.__setCommissions(PAID);

// The fetches resolve on a microtask, so the first paint is the loading
// state; flush before asserting on content.
let page = renderPage();
await act(async () => {});

check("the page renders the collected figure", page.text().includes("$1,100.00"),
  page.text().slice(0, 200));
check("the uncollected job is called out separately",
  page.text().includes("Finished, not collected") && page.text().includes("$300.00"));
check("both reps appear", page.text().includes("Trenton") && page.text().includes("Marcus"));
check("the rep over the threshold is flagged", page.text().includes("Required"));
check("the one under it is shown as under, not flagged",
  page.text().includes(`Under $${NEC_THRESHOLD}`));
check("the January 31 deadline is stated with the right year",
  page.text().includes("January 31, 2027"), "deadline line missing");
check("the page says out loud that it has no expenses in it",
  /knows nothing about\s+what you spent/.test(page.text()));

// The download path, end to end: a real click, through the real service, to
// a real Blob. This is what catches a column list that doesn't match the row
// shape — the thing a unit test on toCsv alone would miss.
const captured = [];
window.URL.createObjectURL = (blob) => {
  captured.push(blob);
  return "blob:fake";
};
window.URL.revokeObjectURL = () => {};

const incomeBtn = page.findButton("Download 3 jobs");
check("the income button counts the year's jobs", !!incomeBtn,
  [...page.host.querySelectorAll("button")].map((b) => b.textContent).join(" | "));
act(() => incomeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
check("clicking it produces a file", captured.length === 1);

// Read the raw bytes, not .text(). Blob.text() performs a spec "UTF-8
// decode", which strips a leading BOM — so a text-level assertion here would
// pass identically whether the BOM was written or not, and quietly stop
// testing anything the day it was dropped.
const csvBytes = new Uint8Array(await captured[0].arrayBuffer());
check(
  "the file opens as UTF-8 in Excel (BOM is really in the bytes)",
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  [...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(" ")
);

const csvText = await captured[0].text();
check("the income CSV header matches the columns",
  csvText.split("\r\n")[0].replace("﻿", "") ===
    INCOME_COLUMNS.map((c) => c.label).join(","),
  csvText.split("\r\n")[0]);
check("the income CSV has one row per job plus a header",
  csvText.trim().split("\r\n").length === 4,
  String(csvText.trim().split("\r\n").length));

captured.length = 0;
const repBtn = page.findButton("Per person");
act(() => repBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const repText = await captured[0].text();
check("the 1099 summary names the rep and the flag",
  repText.includes("Trenton") && repText.includes("YES"), repText);
check("the 1099 summary is one row per person, not per payment",
  repText.trim().split("\r\n").length === 3,
  String(repText.trim().split("\r\n").length));

// Switching years must actually re-derive, not show a stale total.
page.click(".tax__year", 1); // 2025, second in the newest-first list
check("switching to 2025 shows that year's income",
  page.text().includes("$900.00"), page.text().slice(0, 300));
check("...and that year's single payout, not the other year's",
  page.text().includes("Trenton") && !page.text().includes("Marcus"));

page.done();

// A year with nothing in it must explain itself rather than look broken.
fake.__setJobs([]);
fake.__setCommissions([]);
page = renderPage();
await act(async () => {});
check("an empty year says why the payout table is empty",
  page.text().includes("Nothing was marked paid"), page.text().slice(0, 200));
check("the download buttons are disabled when there is nothing to download",
  [...page.host.querySelectorAll(".tax__dl")].every((b) => b.disabled));
page.done();

// --- report ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  — " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
