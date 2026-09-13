import { supabase } from "../supabaseClient";

/**
 * What the CRM can hand an accountant at tax time.
 *
 * Scope, stated plainly so nobody expects more of this than it gives: this
 * is the REVENUE side and the CONTRACTOR PAYOUT side. It is not bookkeeping.
 * It does not know what was spent on soap, gas, ladders, hosting or
 * insurance, and it should not try to — that lives in a bank feed, and a
 * half-built expense tracker in here would be worse than none, because it
 * would look authoritative while missing every purchase made on a day
 * somebody forgot to open the CRM.
 *
 * Two exports come out of this:
 *
 *   1. Every completed job in a calendar year. The gross receipts line.
 *   2. What each rep was actually PAID in that year, for 1099-NEC.
 *
 * Those two use different dates on purpose — see fetchPayoutRows.
 */

// --- CSV ------------------------------------------------------------------

// Excel and Sheets both treat a leading =, +, - or @ as the start of a
// formula, so a customer who typed "-see note" into an address field becomes
// an expression when the CPA opens the file. Prefixing a single quote is the
// standard defusal and is invisible in the cell.
//
// Not paranoia for its own sake: these fields are typed by whoever added the
// lead, on a phone, at a door.
const RISKY_LEAD = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (RISKY_LEAD.test(s)) s = "'" + s;
  // Quote when the value contains anything that would otherwise break the
  // row, and double any quote inside it.
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Rows to CSV text.
 *
 * `columns` is [{ key, label }] so the header and the field order can never
 * drift apart, which is what happens the moment they are two separate arrays.
 */
export function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => csvCell(row[c.key])).join(",")
  );
  // CRLF: the line ending every spreadsheet on Windows expects, and Jordan
  // is on Windows.
  return [head, ...body].join("\r\n") + "\r\n";
}

/**
 * Hand the browser a file.
 *
 * The BOM is not decoration. Without it Excel reads the file as the system
 * codepage and mangles any accented character in a customer's name; with it
 * the same file opens as UTF-8 by double-click. Sheets and Numbers ignore it.
 */
export function downloadCsv(filename, csv) {
  // Written as an escape, not as a literal BOM character. A raw U+FEFF sitting
  // invisibly in a source file is the kind of thing an editor, a formatter or
  // a copy-paste silently eats, and its absence is undetectable by eye.
  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed on the next tick rather than immediately — revoking synchronously
  // races the click in Safari and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// --- dates ----------------------------------------------------------------

// A tax year is a LOCAL calendar year. Comparing UTC would file a job done
// at 5pm on December 31st in Corvallis under the following year.
export function yearOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

// YYYY-MM-DD, local. Sorts correctly as text, which a US-format date does
// not, and every spreadsheet parses it as a date without being asked.
export function isoDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- revenue --------------------------------------------------------------

// What was actually charged. final_price is what the customer paid after any
// upsell on the day; price is the quote. The quote is kept alongside so the
// difference is visible rather than silently absorbed.
export function chargedAmount(job) {
  return Number(job.final_price ?? job.price ?? 0);
}

export async function fetchCompletedJobsForTax() {
  const { data, error } = await supabase
    .from("jobs")
    .select(
      `
      id, starts_at, status, paid, price, final_price, payment_method,
      visit_number, service_plan, property_type, address,
      lead:lead_id ( name, address ),
      customer:customer_id ( name, address )
    `
    )
    .eq("status", "completed")
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data || [];
}

// One flat row per job, in the shape an accountant reads left to right.
export function incomeRows(jobs, year) {
  return jobs
    .filter((j) => yearOf(j.starts_at) === year)
    .map((j) => ({
      date: isoDate(j.starts_at),
      customer: j.customer?.name || j.lead?.name || "Unnamed",
      address: j.address || j.customer?.address || j.lead?.address || "",
      plan: j.service_plan || "",
      property: j.property_type || "",
      visit: j.visit_number ?? "",
      quoted: Number(j.price ?? 0).toFixed(2),
      charged: chargedAmount(j).toFixed(2),
      method: j.payment_method || "",
      // Surfaced rather than assumed. completeJob sets paid = true, but jobs
      // reach 'completed' by other routes too, and an unpaid completed job is
      // a receivable, not revenue — the difference matters on a cash-basis
      // return and nobody will notice it if the column isn't here.
      paid: j.paid ? "yes" : "no",
      job_id: j.id,
    }));
}

export const INCOME_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "customer", label: "Customer" },
  { key: "address", label: "Address" },
  { key: "plan", label: "Plan" },
  { key: "property", label: "Property type" },
  { key: "visit", label: "Visit #" },
  { key: "quoted", label: "Quoted" },
  { key: "charged", label: "Charged" },
  { key: "method", label: "Payment method" },
  { key: "paid", label: "Collected" },
  { key: "job_id", label: "Job ID" },
];

// Gross receipts, plus the part of it that hasn't actually been collected.
export function summariseIncome(rows) {
  let collected = 0;
  let outstanding = 0;
  for (const r of rows) {
    const amount = Number(r.charged) || 0;
    if (r.paid === "yes") collected += amount;
    else outstanding += amount;
  }
  return {
    jobs: rows.length,
    collected,
    outstanding,
    gross: collected + outstanding,
  };
}

// Month-by-month, for a sanity check against the bank statements. If a month
// here disagrees with the deposits, something was collected and never
// recorded — which is exactly what you want to find in February, not in an
// audit.
export function monthlyIncome(rows) {
  const months = Array.from({ length: 12 }, () => ({ jobs: 0, collected: 0 }));
  for (const r of rows) {
    const m = Number(r.date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    months[m].jobs += 1;
    if (r.paid === "yes") months[m].collected += Number(r.charged) || 0;
  }
  return months;
}

// --- contractor payouts ---------------------------------------------------

/**
 * What each rep was PAID during a calendar year.
 *
 * The date is `paid_at`, not `earned_at`, and that distinction is the whole
 * reason this function exists rather than reusing the commission page's
 * numbers. A 1099-NEC reports cash that actually left the business inside the
 * calendar year. A fee earned in December and paid in January belongs on next
 * year's form; the commission page, which is answering "what am I owed",
 * quite correctly shows it this year. Both are right about different
 * questions.
 *
 * Reversals net out on their own: a reversal row carries a negative amount,
 * so if it was itself marked paid it reduces the year it was paid in.
 */
export async function fetchPaidCommissions() {
  const { data, error } = await supabase
    .from("commissions")
    .select(
      `
      id, kind, rate, base_amount, amount, status, paid_at, earned_at,
      note, reversal_of,
      profile:profile_id ( id, full_name, role ),
      lead:lead_id ( name ),
      job:job_id ( starts_at, visit_number, customer:customer_id ( name ) )
    `
    )
    .eq("status", "paid")
    .order("paid_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

function subjectOf(row) {
  const name = row.job?.customer?.name || row.lead?.name || "Unnamed";
  const visit = row.job?.visit_number > 1 ? ` (visit ${row.job.visit_number})` : "";
  return `${name}${visit}`;
}

export function payoutRows(commissions, year) {
  return commissions
    .filter((c) => yearOf(c.paid_at) === year)
    .map((c) => ({
      paid_on: isoDate(c.paid_at),
      rep: c.profile?.full_name || "Unknown",
      role: c.profile?.role || "",
      kind: c.reversal_of ? "reversal" : c.kind,
      subject: subjectOf(c),
      job_date: isoDate(c.job?.starts_at),
      rate: c.rate === null || c.rate === undefined ? "" : Number(c.rate).toFixed(2),
      base: Number(c.base_amount ?? 0).toFixed(2),
      amount: Number(c.amount ?? 0).toFixed(2),
      earned_on: isoDate(c.earned_at),
      commission_id: c.id,
      profile_id: c.profile?.id || "",
    }));
}

export const PAYOUT_COLUMNS = [
  { key: "paid_on", label: "Date paid" },
  { key: "rep", label: "Paid to" },
  { key: "role", label: "Role" },
  { key: "kind", label: "For" },
  { key: "subject", label: "Job" },
  { key: "job_date", label: "Job date" },
  { key: "rate", label: "Rate %" },
  { key: "base", label: "Job amount" },
  { key: "amount", label: "Commission" },
  { key: "earned_on", label: "Date earned" },
  { key: "commission_id", label: "Commission ID" },
];

// Below this, no 1099-NEC is required. At or above it, one is — and it is due
// to both the contractor and the IRS by January 31st.
export const NEC_THRESHOLD = 600;

/**
 * One line per person, which is the shape a 1099 actually needs.
 *
 * Everyone who was paid anything appears, including people under the
 * threshold: "you owe Trenton a form and Marcus nothing" is only a useful
 * answer if you can see Marcus and the number that put him under.
 */
export function payoutsByRep(rows) {
  const byId = new Map();
  for (const r of rows) {
    const key = r.profile_id || r.rep;
    if (!byId.has(key)) {
      byId.set(key, {
        profile_id: r.profile_id,
        rep: r.rep,
        role: r.role,
        payments: 0,
        total: 0,
        first_paid: r.paid_on,
        last_paid: r.paid_on,
      });
    }
    const acc = byId.get(key);
    acc.payments += 1;
    acc.total += Number(r.amount) || 0;
    if (r.paid_on < acc.first_paid) acc.first_paid = r.paid_on;
    if (r.paid_on > acc.last_paid) acc.last_paid = r.paid_on;
  }

  return [...byId.values()]
    .map((v) => ({
      ...v,
      total: Number(v.total.toFixed(2)),
      needs_1099: v.total >= NEC_THRESHOLD,
    }))
    .sort((a, b) => b.total - a.total);
}

export const REP_COLUMNS = [
  { key: "rep", label: "Paid to" },
  { key: "role", label: "Role" },
  { key: "total", label: "Total paid" },
  { key: "payments", label: "Payments" },
  { key: "first_paid", label: "First payment" },
  { key: "last_paid", label: "Last payment" },
  { key: "needs_1099", label: "1099-NEC required" },
  { key: "profile_id", label: "Profile ID" },
];

// The rep summary as CSV rows — booleans spelled out, because "TRUE" in a
// column headed "1099-NEC required" is read correctly by a human at a glance
// and "true" lowercase looks like a bug.
export function repCsvRows(reps) {
  return reps.map((r) => ({
    ...r,
    total: r.total.toFixed(2),
    needs_1099: r.needs_1099 ? "YES" : "no",
  }));
}

// Which years there is anything to report on, newest first. Derived from the
// data rather than hardcoded, so the picker never offers an empty year or
// omits a real one.
export function availableYears(jobs, commissions) {
  const years = new Set();
  for (const j of jobs) {
    const y = yearOf(j.starts_at);
    if (y) years.add(y);
  }
  for (const c of commissions) {
    const y = yearOf(c.paid_at);
    if (y) years.add(y);
  }
  // Always offer the current year even before the first job lands in it,
  // so the page is never empty of options in January.
  years.add(new Date().getFullYear());
  return [...years].sort((a, b) => b - a);
}
