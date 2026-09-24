import { supabase } from "../supabaseClient";

/*
 * Messages that did not arrive — texts and emails both.
 *
 * Five states across two channels, and the differences are not cosmetic:
 * each one calls for something different from whoever is reading the screen.
 *
 *   TEXTS
 *   undelivered — the carrier took it and refused it. Landline, disconnected,
 *                 filtered. Sending the same text again fails the same way,
 *                 so the answer is another channel or another number.
 *   failed      — it never reached the carrier at all: the send errored, or a
 *                 nightly run died partway and sweep_sms() reclaimed the row.
 *                 Nobody has seen it and sending again is safe.
 *
 *   EMAILS
 *   bounced     — the receiving server refused it. Permanent (the mailbox
 *                 does not exist) or temporary (it was full); permanent says
 *                 which.
 *   complained  — they marked us as spam. The strongest signal there is, and
 *                 the one thing on this screen that should never be cleared
 *                 without a conversation first.
 *   failed      — never reached Resend. Same meaning as a failed text, on
 *                 purpose: the two halves of one list must not use the same
 *                 word for different things.
 *
 * See db/sms-delivery.sql and db/email-delivery.sql.
 */

// What the view is called. Named once because two functions read it and a
// typo in the second one is a screen that works until you open a quote.
const FEED = "delivery_failures";

/**
 * How urgent this is, as a number to sort by. Higher comes first.
 *
 * A failed day-before confirmation outranks everything, and it is not close.
 * A quote nobody received can be chased next week and is still worth the
 * same money. A confirmation nobody received EXPIRES OVERNIGHT: tomorrow
 * morning two people drive to a house that isn't expecting them, the gate is
 * locked, and the first anyone knows is standing on the driveway.
 *
 * Only while the job is still ahead of us. Yesterday's failed reminder is
 * history — it belongs in the list, but putting it above a live one would
 * make the top of the screen useless within a week.
 */
export function urgency(row, now = Date.now()) {
  if (row?.kind === "reminder" && row?.job_at && new Date(row.job_at) > now) {
    return 2;
  }
  // A spam complaint is not urgent, it is permanent — but it is the only
  // thing here that also affects everyone else, because complaints are what
  // gets a sending domain blocked.
  if (row?.status === "complained") return 1;
  return 0;
}

function newestFirst(rows, now = Date.now()) {
  return [...rows].sort((a, b) => {
    const u = urgency(b, now) - urgency(a, now);
    if (u) return u;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

/** Everything that didn't arrive, most pressing first. */
export async function fetchFailures({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from(FEED)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  // Sorted again here rather than in the view: "is this job still ahead of
  // us" is a question about the moment the page is being looked at, and a
  // view that answered it would be answering it as of whenever PostgREST got
  // round to the query.
  return newestFirst(data || []);
}

/**
 * Which of these quotes failed to reach the customer.
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
    // From the view, not the tables underneath it.
    //
    // sms_messages has the status and the carrier's error but not whether
    // the refusal was PERMANENT — that is sb_sms_permanent() applied in the
    // view. Reading the table directly meant whatToDo() never saw a
    // permanent flag and fell through to "worth trying again" on a landline,
    // which is the one piece of advice that is certainly wrong.
    //
    // It also covers the EMAIL now, which matters more than it looks: when a
    // text is refused the CRM emails the quote instead, so the interesting
    // case is exactly the one where both have failed.
    const { data, error } = await supabase
      .from(FEED)
      .select(
        "channel, quote_id, status, kind, error, created_at, permanent, blocked"
      )
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
    console.error("Couldn't load delivery status:", e);
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

/** Addresses currently closed to email. */
export async function fetchClosedEmails() {
  const { data, error } = await supabase
    .from("email_unreachable")
    .select("*")
    .is("cleared_at", null)
    .order("last_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Let a number or an address back in — they got a new phone, or the digits
 * were wrong and have been fixed.
 *
 * Through the functions rather than an UPDATE so who cleared it is recorded.
 * If it is refused again, it closes again on its own.
 */
export async function clearUnreachable(phone) {
  const { data, error } = await supabase.rpc("clear_sms_unreachable", {
    p_phone: phone,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function clearClosedEmail(email) {
  const { data, error } = await supabase.rpc("clear_email_unreachable", {
    p_email: email,
  });
  if (error) throw error;
  return Boolean(data);
}

/* --- saying it in words ---------------------------------------------------- */

const LABELS = {
  undelivered: "Not delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Never sent",
};

export function failureLabel(row) {
  return LABELS[row?.status] || "Didn't arrive";
}

/** "text" / "email", for a sentence rather than a column. */
export function channelWord(row) {
  return row?.channel === "email" ? "email" : "text";
}

/**
 * Which message this was, in words a person uses.
 *
 * The kinds are database words — nudge_sent, quote_fallback — and showing
 * them raw makes the screen look like a log file. It is a log file; it
 * should not look like one.
 */
const KINDS = {
  quote: "Quote",
  quote_fallback: "Quote, emailed after the text failed",
  nudge_sent: "Quote follow-up",
  nudge_viewed: "Quote follow-up",
  reminder: "Day-before confirmation",
  follow_up: "Review request",
  receipt: "Receipt",
  unknown: "Message",
};

export function kindLabel(row) {
  return KINDS[row?.kind] || row?.kind || "Message";
}

/**
 * What to do about it, in one line.
 *
 * The provider's own error is kept and shown too, but "destination not
 * found" is not an instruction. This is.
 *
 * Ordered by what the reader needs, not by what happened: the reminder case
 * comes first because it is the only one with a deadline on it.
 */
export function whatToDo(row, now = Date.now()) {
  if (!row) return "";

  if (row.kind === "reminder" && row.job_at && new Date(row.job_at) > now) {
    const when = new Date(row.job_at).toLocaleString("en-US", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    });
    return `They have not been told we're coming ${when}. Call them today.`;
  }

  if (row.status === "complained") {
    return "They marked us as spam. Don't email them again — call instead.";
  }

  if (row.status === "failed") {
    return "It never left the CRM, so sending it again is safe.";
  }

  if (row.permanent || row.blocked) {
    return row.channel === "email"
      ? "This address is dead. Call them, or text it instead."
      : "This number can't receive texts. Call them, or email it instead.";
  }

  return row.channel === "email"
    ? "Their mail server didn't take it. Worth trying again, or call them."
    : "The carrier didn't deliver it. Worth trying again, or call them.";
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

/** "Tomorrow at 9:00 AM" — for the job a failed reminder was about. */
export function jobWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
