import { supabase } from "../supabaseClient";

/*
 * Texts that did not arrive.
 *
 * Two states, and the difference decides what you do about it:
 *
 *   undelivered — the carrier took it and refused it. Landline, disconnected,
 *                 filtered. Sending the same text again will fail the same
 *                 way, so the answer is another channel or another number.
 *
 *   failed      — it never reached the carrier at all: the send errored, or a
 *                 nightly run died partway and sweep_sms() reclaimed the row.
 *                 Nobody has seen it and sending again is safe.
 *
 * See db/sms-delivery.sql for why those are two states and not one.
 */

/** Everything that didn't arrive, newest first. */
export async function fetchFailures({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from("sms_failures")
    .select("*")
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Which of these quotes had their text refused.
 *
 * Keyed by quote id so a panel can mark the rows it is already showing,
 * rather than every quote row asking the database about itself — twelve
 * quotes on a customer would be twelve round trips for a line of red text.
 *
 * Returns a plain object, and an EMPTY one if anything goes wrong. A panel
 * that can't say "this didn't arrive" should still show the quotes; the
 * badge is an improvement on the list, not a condition of it.
 */
export async function fetchQuoteDelivery(quoteIds = []) {
  const ids = quoteIds.filter(Boolean);
  if (ids.length === 0) return {};

  try {
    // From the view, not the table underneath it.
    //
    // sms_messages has the status and the carrier's error but not whether
    // the refusal was PERMANENT — that is sb_sms_permanent() applied in
    // sms_failures. Reading the table directly meant whatToDo() never saw a
    // permanent flag and fell through to "worth trying again" on a landline,
    // which is the one piece of advice that is certainly wrong.
    const { data, error } = await supabase
      .from("sms_failures")
      .select("quote_id, status, error, created_at, permanent, number_blocked")
      .in("quote_id", ids);
    if (error) throw error;

    const byQuote = {};
    for (const row of data || []) {
      // Newest wins: a quote re-sent after a number was fixed should show the
      // most recent attempt, not the first failure forever.
      const seen = byQuote[row.quote_id];
      if (!seen || row.created_at > seen.created_at) byQuote[row.quote_id] = row;
    }
    return byQuote;
  } catch (e) {
    console.error("Couldn't load text delivery status:", e);
    return {};
  }
}

/** Numbers currently closed to texts. */
export async function fetchUnreachable() {
  const { data, error } = await supabase
    .from("sms_unreachable")
    .select("*")
    .is("cleared_at", null)
    .order("last_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Let a number back in — they got a new phone, or the digits were wrong and
 * have been fixed.
 *
 * Through the function rather than an UPDATE so who cleared it is recorded.
 * If the carrier refuses it again, it closes again on its own.
 */
export async function clearUnreachable(phone) {
  const { data, error } = await supabase.rpc("clear_sms_unreachable", {
    p_phone: phone,
  });
  if (error) throw error;
  return Boolean(data);
}

/* --- saying it in words ---------------------------------------------------- */

export function failureLabel(row) {
  return row?.status === "undelivered" ? "Not delivered" : "Never sent";
}

/**
 * What to do about it, in one line.
 *
 * The carrier's own error is kept and shown too, but "destination not found"
 * is not an instruction. This is.
 */
export function whatToDo(row) {
  if (!row) return "";
  if (row.status === "failed") {
    return "It never left the CRM, so sending it again is safe.";
  }
  if (row.permanent || row.number_blocked) {
    return "This number can't receive texts. Call them, or email it instead.";
  }
  return "The carrier didn't deliver it. Worth trying again, or call them.";
}

export function formatPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10
    ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
    : p || "";
}

export function shortWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
