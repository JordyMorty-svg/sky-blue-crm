import { supabase } from "../supabaseClient";

/**
 * Reading and settling the commission ledger.
 *
 * The rows themselves are written entirely by database triggers (see
 * db/commissions.sql) — nothing here creates one. That is deliberate: a
 * commission that only appears when the app remembers to write it is a
 * commission that goes missing the first time someone changes a lead from
 * the Supabase table editor.
 *
 * Row-level security does the filtering. A rep's query returns their own
 * rows because the policy says so, not because this file adds a `.eq()` —
 * which means a rep cannot see another rep's earnings even by editing the
 * request in their browser.
 */

// Everything the page needs to describe a row, in one round trip. The lead
// carries the name you'd recognise a job by before a customer exists; the
// job carries the date and the real price once one does.
const SELECT = `
  id, kind, rate, base_amount, amount, status,
  earned_at, payable_at, paid_at, note, reversal_of,
  profile:profile_id ( id, full_name, role ),
  lead:lead_id ( id, name, status, estimate ),
  job:job_id (
    id, starts_at, status, paid, price, final_price, visit_number,
    customer:customer_id ( id, name )
  )
`;

// One rep's ledger, or everyone's.
//
// `profileId` is an optional narrowing for the admin view; a rep can omit it
// and RLS returns exactly their own rows anyway. Passing your own id when
// you are not an admin is harmless and returns the same thing.
export async function fetchCommissions({ profileId = null } = {}) {
  let query = supabase
    .from("commissions")
    .select(SELECT)
    .order("earned_at", { ascending: false });

  if (profileId) query = query.eq("profile_id", profileId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Everyone who can earn commission, whether or not they have yet.
//
// The admin view used to be built purely from the ledger, so a rep with no
// rows simply did not exist on the page — which is exactly the person you
// want to see. A new hire looks identical to someone you forgot to
// onboard, and there is no way to check the payroll roster against reality.
//
// Inactive profiles are included rather than filtered. Someone who has left
// may still be owed for their last week, and a page that hides them hides
// the debt; they are marked instead.
export async function fetchCommissionReps() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, active, commission_eligible")
    .in("role", ["tech", "partner"])
    .order("full_name");
  if (error) throw error;
  return data || [];
}

// Mark payable rows paid. Owners only — the database refuses anyone else,
// so this cannot be worked around by calling it from a console.
export async function markCommissionsPaid(ids) {
  if (!ids || ids.length === 0) return 0;
  const { data, error } = await supabase.rpc("sb_mark_commissions_paid", {
    p_ids: ids,
  });
  if (error) throw error;
  return data ?? 0;
}

// The signed-in rep's own effective rates. Read from the database rather
// than assumed, because an override like Trenton's 15% would otherwise make
// the page's own header disagree with the rows underneath it.
export async function fetchMyRates() {
  const { data, error } = await supabase.rpc("sb_my_commission_rates");
  if (error) throw error;
  // RETURNS TABLE comes back as an array of one row.
  const r = Array.isArray(data) ? data[0] : data;
  if (!r) return null;
  return {
    find: Number(r.find_rate),
    book: Number(r.book_rate),
    work: Number(r.work_rate),
  };
}

export const KIND_LABELS = {
  find: "Found the lead",
  book: "Booked it",
  work: "Worked the job",
};

export const KIND_SHORT = {
  find: "Found",
  book: "Booked",
  work: "Worked",
};

/**
 * What to show for one row, and — crucially — whether to show money at all.
 *
 * The rule is Jordan's: you see the percentage from the moment you earn it,
 * but you only see a number once there is a number to show. A lead that has
 * been contacted and not yet quoted has no price, so quoting a dollar figure
 * against it would be inventing one. Everything before the cash lands is
 * marked estimated, because it is: the amount follows the quote, then the
 * final price, and an upsell moves it up on the day.
 */
export function stateFor(row) {
  if (row.reversal_of) {
    return {
      key: "reversal",
      label: "Reversal",
      tone: "void",
      showMoney: true,
      note: "Offsets an earlier commission",
    };
  }
  if (row.status === "void") {
    // Two different things end up here — a refund that was reversed, and a
    // lead that went cold and had its fees reset — so the label is neutral
    // and the database's own note carries the reason. Hardcoding
    // "Reversed" told a rep their archived lead had been refunded.
    const cold = /commission reset/i.test(row.note || "");
    return {
      key: "void",
      label: cold ? "Lead went cold" : "Cancelled",
      tone: "void",
      showMoney: true,
      note: row.note || "Cancelled — a matching negative row was booked",
    };
  }
  if (row.status === "paid") {
    return { key: "paid", label: "Paid", tone: "paid", showMoney: true };
  }
  if (row.status === "payable") {
    return {
      key: "payable",
      label: "Ready to pay",
      tone: "payable",
      showMoney: true,
      note: "Job finished and the money is in",
    };
  }

  // Pending. The only question left is whether anyone has put a price on it.
  const priced = Number(row.base_amount) > 0;
  if (!priced) {
    return {
      key: "unpriced",
      label: "No quote yet",
      tone: "pending",
      showMoney: false,
      note: "You'll see a figure once this is quoted",
    };
  }
  return {
    key: "estimated",
    label: "Estimated",
    tone: "pending",
    showMoney: true,
    estimated: true,
    note: "Not payable until the job is done and paid for",
  };
}

// Totals for the three buckets a rep actually cares about, plus a count of
// the rows that have no figure yet so the page can say "and 3 more, not yet
// quoted" rather than silently omitting them.
export function summarise(rows) {
  const out = { estimated: 0, payable: 0, paid: 0, unpriced: 0, total: 0 };
  for (const row of rows) {
    const state = stateFor(row);
    const amount = Number(row.amount) || 0;
    if (state.key === "unpriced") {
      out.unpriced += 1;
      continue;
    }
    if (state.key === "void") continue; // its reversal carries the negative
    if (state.key === "estimated") out.estimated += amount;
    else if (state.key === "payable" || state.key === "reversal")
      out.payable += amount;
    else if (state.key === "paid") out.paid += amount;
  }
  out.total = out.estimated + out.payable + out.paid;
  return out;
}

// What this row was for, in the words someone would use out loud.
export function subjectFor(row) {
  const customer = row.job?.customer?.name;
  const lead = row.lead?.name;
  const name = customer || lead || "Unnamed";
  const visit =
    row.job?.visit_number > 1 ? ` · visit ${row.job.visit_number}` : "";
  return `${name}${visit}`;
}

export function money(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
