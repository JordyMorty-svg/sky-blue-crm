import { supabase } from "../supabaseClient";

/**
 * The automatic follow-up email, from the CRM's side.
 *
 * The sending itself happens on a schedule in
 * netlify/functions/send-follow-ups.mjs — nothing here sends anything. What
 * the app can do is see what is queued and stop it, which is the point:
 * three days is long enough to remember that a job went badly.
 *
 * See db/follow-ups.sql.
 */

// The queued (or already sent) follow-up for one job, or null.
//
// maybeSingle rather than single: most jobs have no row at all — anything
// completed before db/follow-ups.sql was run, and anything still scheduled.
// A missing row is the normal case, not an error.
export async function fetchFollowUp(jobId) {
  const { data, error } = await supabase
    .from("follow_ups")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Everything ever queued for one customer, newest first. Used on the
// customer profile to answer "have we already asked them for a review?"
export async function fetchCustomerFollowUps(customerId) {
  const { data, error } = await supabase
    .from("follow_ups")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Call it off. Goes through the database function rather than an update, so
// a person can only ever move a row to 'skipped' — the app has no way to
// mark something sent, which keeps the send path honest.
export async function skipFollowUp(jobId, reason = null) {
  const { error } = await supabase.rpc("skip_follow_up", {
    p_job_id: jobId,
    p_reason: reason,
  });
  if (error) throw error;
}

// "Don't email this customer." Cancels anything already queued for them the
// next time the sender sweeps, because the rule is re-checked at send time.
export async function setEmailOptOut(customerId, optOut) {
  const { error } = await supabase
    .from("customers")
    .update({ email_opt_out: optOut })
    .eq("id", customerId);
  if (error) throw error;
}

// "They've already left a review." Stops future review requests without
// touching email_opt_out, which means something different and stronger.
//
// A timestamp rather than a boolean: the profile can then say WHEN, which is
// the difference between a fact and a vague recollection — and if the review
// ask ever becomes "ask again after two years", the date is already there.
export async function setCustomerReviewed(customerId, reviewed) {
  const { error } = await supabase
    .from("customers")
    .update({ reviewed_at: reviewed ? new Date().toISOString() : null })
    .eq("id", customerId);
  if (error) throw error;
}

// --- running the sender by hand ---------------------------------------------
//
// /api/run-follow-ups is behind a login, so it can't be poked by visiting the
// URL — a browser won't send the bearer token and gets a 401. That's the
// right call for an endpoint that emails customers, but it does mean the
// only way to reach it is from in here, with a session in hand. Same shape
// as every other Netlify function this app calls (see paymentService).
//
// GET  = preview. Works out who is due and changes nothing.
// POST = send, for real.
async function callRunner(method, body = null) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/run-follow-ups", {
    method,
    headers: {
      Authorization: `Bearer ${session?.access_token || ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  // The server passes the database's own refusal through as `error`, and
  // those are written as sentences for a person ("Dana Whitfield has
  // unsubscribed from follow-up emails"). Surface it rather than replacing
  // it with something generic.
  if (!res.ok) throw new Error(data.error || `Run failed (${res.status})`);
  return data;
}

// Who would be emailed if it ran right now. Sends nothing.
export function previewFollowUps() {
  return callRunner("GET");
}

// Actually send. Ignores FOLLOW_UPS_MODE — a person pressed the button — but
// every database rule still applies, so this can't reach someone who opted
// out or is inside their quiet period.
export function sendFollowUpsNow() {
  return callRunner("POST");
}

// Send a review request to one named customer, now. Skips the due date and
// the quiet period, because those rules exist to keep the AUTOMATION
// thoughtful and a person choosing a name is the judgement they stand in
// for. Still refused for an unsubscribed customer — see
// claim_manual_follow_up in db/follow-ups.sql, which raises a message
// written to be shown to whoever pressed the button.
export function sendFollowUpToCustomer(customerId) {
  return callRunner("POST", { customerId });
}

// --- wording ---------------------------------------------------------------

export function followUpDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/**
 * One sentence describing where a follow-up has got to.
 *
 * `tone` is "waiting" | "done" | "off" | "problem" — the page colours the
 * row from that rather than re-deriving meaning from the status string.
 */
export function describeFollowUp(row) {
  if (!row) return null;

  switch (row.status) {
    case "pending":
      return {
        tone: "waiting",
        text: `Review request goes out ${followUpDate(row.due_at)}`,
        canSkip: true,
      };
    case "sending":
      return { tone: "waiting", text: "Review request is sending now", canSkip: false };
    case "sent":
      return {
        tone: "done",
        text: `Review request sent ${followUpDate(row.sent_at)}${
          row.sent_to ? ` to ${row.sent_to}` : ""
        }`,
        canSkip: false,
      };
    case "skipped":
      return {
        tone: "off",
        // The note is the whole value here — "skipped" alone leaves you
        // wondering whether someone did it on purpose or something broke.
        text: `No review request — ${row.note || "skipped"}`,
        canSkip: false,
      };
    case "failed":
      return {
        tone: "problem",
        text: `Review request didn't send — ${row.note || "unknown error"}. It'll retry.`,
        canSkip: true,
      };
    default:
      return { tone: "off", text: row.status, canSkip: false };
  }
}
