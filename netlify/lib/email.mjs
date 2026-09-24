// netlify/lib/email.mjs
//
// Every email the CRM sends to a customer goes through here.
//
// Not for tidiness. Until now each email had its own copy of the Resend
// call — the quote had one, the quote's own fallback had a second, the
// follow-up run had a third — and all three shared one property: they posted
// the message, read the id out of the reply, and forgot it. Nothing was
// written down, so the CRM could not answer "was this customer ever actually
// emailed", let alone "did it arrive".
//
// db/sms-delivery.sql fixed that for texts. This is the other half.
//
// Two things happen here that did not happen before:
//
//   1. A send is RECORDED, with the provider's id, before anyone is told it
//      worked. That id is the only handle a later bounce webhook has.
//
//   2. A closed address is REFUSED. An address that hard-bounced or reported
//      us as spam is not emailed again — not because it would fail, but
//      because it succeeds at Resend and fails silently afterwards, forever,
//      once per nightly run.
//
// Environment:
//   RESEND_API_KEY             — required, or nothing sends
//   SUPABASE_SERVICE_ROLE_KEY  — required to record anything
//   RESEND_FROM / RECEIPT_FROM — default From, per-caller override

import { rpc, rpcQuietly } from "./db.mjs";

/**
 * Did the database say yes?
 *
 * Only an explicit yes counts, and everything else means no.
 *
 * `Boolean(answer)` was the obvious version and it is a trap: an empty array
 * is TRUTHY in JavaScript, so a call that came back `[]` — which is what
 * PostgREST hands over for a function that returned no rows — would read as
 * "this address is closed" and silently refuse to send any email at all,
 * to anyone, forever. Nothing would error. The CRM would just stop emailing
 * customers.
 *
 * Unwraps the shapes PostgREST actually uses for a scalar: the bare value, a
 * single-element array, or an object keyed by the function name.
 */
export function isTrue(v) {
  if (Array.isArray(v)) return isTrue(v[0]);
  if (v && typeof v === "object") return isTrue(Object.values(v)[0]);
  return v === true || v === "true" || v === "t";
}

/**
 * Send one, and write down what happened.
 *
 * Resolves rather than throwing, always. Every caller is partway through
 * something — a quote row already exists, a text has already been recorded
 * as refused — and none of them can undo their work because Resend was
 * briefly unreachable. So the outcome is reported, not raised.
 *
 * Returns { ok, id, reason, skipped }.
 *   skipped: "unreachable" — deliberately not sent. Not a failure, and the
 *            caller should say so rather than reporting an error nobody can
 *            act on by retrying.
 */
export async function sendEmail({
  kind,
  to,
  subject,
  html,
  text = null,
  from = null,
  replyTo = null,
  headers = null,
  leadId = null,
  customerId = null,
  quoteId = null,
  jobId = null,
  sentBy = null,
  // A person pressing Send may email an address the automation has given up
  // on — they may know something the bounce didn't, or be about to fix it.
  // The automation never sets this.
  force = false,
}) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, reason: "RESEND_API_KEY is not set" };
  }
  if (!to) return { ok: false, reason: "no email address" };

  const sender = from || process.env.RESEND_FROM || process.env.RECEIPT_FROM;
  if (!sender) {
    return { ok: false, reason: "no From address (set RECEIPT_FROM)" };
  }

  if (!force) {
    // Through the database, not a cached list. The decision has to be the
    // same one the nightly run makes and the same one the CRM screen shows,
    // and there is exactly one copy of it: sb_email_unreachable().
    //
    // A failure to CHECK is not a reason to refuse. If Supabase is
    // unreachable we send — sending to a dead address costs nothing, and
    // not sending a real quote because a lookup timed out costs a job.
    let closed = false;
    try {
      closed = isTrue(await rpc("sb_email_unreachable", { p_email: to }));
    } catch (err) {
      console.error("[email] couldn't check the closed list:", err?.message || err);
    }
    if (closed) {
      return {
        ok: false,
        skipped: "unreachable",
        reason: "that address has bounced or reported us as spam",
      };
    }
  }

  let providerId = null;
  let failure = null;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: sender,
        to: [to],
        reply_to: replyTo || undefined,
        subject,
        html,
        text: text || undefined,
        headers: headers || undefined,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) failure = data?.message || `Resend ${res.status}`;
    else providerId = data?.id || null;
  } catch (err) {
    failure = err?.message || "Resend unreachable";
  }

  // Recorded either way, and the status says which.
  //
  // 'failed' — never reached Resend, nobody has seen it, sending again is
  // safe. Exactly the meaning 'failed' has for a text, deliberately: the two
  // halves of the failures list should not use the same word for different
  // things.
  //
  // rpcQuietly, because a quote that reached the customer but wasn't written
  // down is a much smaller problem than a quote that wasn't sent because
  // writing it down failed.
  await rpcQuietly("record_email_sent", {
    p_kind: kind || "unknown",
    p_to: to,
    p_subject: subject || null,
    p_provider_id: providerId,
    p_status: failure ? "failed" : "sent",
    p_error: failure,
    p_lead_id: leadId,
    p_customer_id: customerId,
    p_quote_id: quoteId,
    p_job_id: jobId,
    p_sent_by: sentBy,
  });

  return failure
    ? { ok: false, reason: failure }
    : { ok: true, id: providerId };
}
