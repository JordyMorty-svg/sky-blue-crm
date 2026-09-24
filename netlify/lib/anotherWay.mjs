// netlify/lib/anotherWay.mjs
//
// The text was refused, so try the other address we have.
//
// This lived inside sms-inbound.mjs, reachable only from the delivery-failure
// webhook branch — and Quo has no delivery-failure webhook. It publishes
// `message.received` and `message.delivered` and nothing else. So the entire
// "email it instead" feature was dead code: it was written, tested, shipped,
// and could never once have run.
//
// The thing that actually discovers a refusal is netlify/lib/smsReconcile.mjs
// asking Quo for the status. So the fallback lives here, where both can reach
// it, and the webhook branch stays wired up in case Quo ever ships the event.
//
// Two kinds get a second route, and nothing else:
//
//   quote     — there is money on the table and a link the customer has to
//               open to accept it.
//   reminder  — the day-before confirmation. The more urgent of the two
//               despite being worth nothing, because it EXPIRES OVERNIGHT: a
//               quote nobody received can be chased next week, a confirmation
//               nobody received means two people drive to a locked gate.
//
// A nudge is left alone deliberately. It is already the second attempt at
// something, and emailing a chase-up to somebody who never saw the first
// message reads as pestering about a quote they have never seen.

import { rpc } from "./db.mjs";
import { emailTheQuote } from "./quoteEmail.mjs";
import { emailTheReminder } from "./reminderEmail.mjs";

/**
 * Where the quote link points.
 *
 * PUBLIC_URL first so a deploy preview never emails a customer a link into
 * the preview. `fallback` is the incoming request's own origin, which only
 * the webhook has — the reconciler runs on a schedule with no request behind
 * it, so it passes nothing and relies on the environment.
 */
function siteBase(fallback = null) {
  const base = process.env.PUBLIC_URL || process.env.URL || fallback;
  return base ? String(base).replace(/\/$/, "") : null;
}

/**
 * Send it the other way.
 *
 * `row` is what mark_sms_undelivered() returned — and it returns a row only
 * the FIRST time a given failure is recorded. That is the whole reason it
 * returns anything, and it is what stops a customer being emailed the same
 * fallback quote once per reconcile pass, every fifteen minutes, forever.
 *
 * Never throws. One caller is a webhook handler that must answer 200 or Quo
 * retries; the other is a scheduled pass that must not abandon the rest of
 * the batch. The failure is already recorded either way, and losing the
 * fallback is a smaller loss than losing the record of why it was needed.
 *
 * Returns what it did, so a caller can log it and a test can assert it.
 */
export async function sendItAnotherWay(row, { origin = null } = {}) {
  try {
    if (row?.out_kind === "reminder" && row?.out_job_id) {
      return await emailTheConfirmation(row);
    }

    if (row?.out_kind !== "quote" || !row?.out_quote_id) {
      return { sent: false, why: "nothing to resend" };
    }

    const rows = await rpc("quote_for_email", { p_quote_id: row.out_quote_id });
    const q = Array.isArray(rows) ? rows[0] : rows;

    // No row means no address to send to, which is ordinary for a lead taken
    // over the phone — not a failure, and nothing to log loudly.
    if (!q?.out_email || !q?.out_token) {
      return { sent: false, why: "no email on file" };
    }

    const base = siteBase(origin);
    if (!base) {
      // Refused rather than guessed. A quote email whose Accept button goes
      // nowhere is worse than no quote email: the customer believes they
      // have been sent something and that we are waiting on them.
      console.error("[anotherWay] no PUBLIC_URL or URL set; not emailing a broken link");
      return { sent: false, why: "no site URL configured" };
    }

    const sent = await emailTheQuote({
      to: q.out_email,
      customerName: q.out_name,
      amount: Number(q.out_amount) || 0,
      link: `${base}/q/${q.out_token}`,
      expires: q.out_expires
        ? new Date(q.out_expires).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
          })
        : null,
      // The person who sent the original quote signs the email too. The
      // customer is receiving the same quote by a different route; it should
      // not arrive from a different name because the first route failed.
      sentByName: q.out_sender_name,
      // So the email is recorded against the same records the text was, and
      // a bounce lands on the right customer in the failures list rather
      // than as an orphan with an address and nothing else.
      leadId: row.out_lead_id,
      customerId: row.out_customer_id,
      quoteId: row.out_quote_id,
      // This IS the rescue attempt. If it bounces too, the failures list
      // should say plainly that both routes to this customer are closed
      // rather than showing what looks like an ordinary quote email.
      kind: "quote_fallback",
    });

    console.log("[anotherWay] quote fell back to email", {
      ok: sent.ok,
      reason: sent.reason || null,
    });
    return { sent: sent.ok, kind: "quote", why: sent.reason || null };
  } catch (err) {
    console.error("[anotherWay] could not send it another way", err);
    return { sent: false, why: String(err?.message || err) };
  }
}

/**
 * Email tomorrow's confirmation, because the text was refused.
 *
 * reminder_for_email() answers with nothing at all unless the job is still
 * scheduled, still in the future, and the customer has an address — so a
 * cancelled job cannot be confirmed by a verdict that arrives late, which
 * would be a worse outcome than saying nothing.
 *
 * When it answers with nothing there is no second route, and that is exactly
 * the row the Undelivered screen exists to put in front of somebody: a
 * person has to pick up the phone.
 */
async function emailTheConfirmation(row) {
  const rows = await rpc("reminder_for_email", { p_job_id: row.out_job_id });
  const j = Array.isArray(rows) ? rows[0] : rows;

  if (!j?.out_email || !j?.out_starts_at) {
    console.log("[anotherWay] reminder had no second route", { job: row.out_job_id });
    return { sent: false, kind: "reminder", why: "no email on file" };
  }

  const sent = await emailTheReminder({
    to: j.out_email,
    customerName: j.out_name,
    startsAt: j.out_starts_at,
    address: j.out_address,
    services: j.out_services,
    leadId: row.out_lead_id,
    customerId: row.out_customer_id,
    jobId: row.out_job_id,
  });

  console.log("[anotherWay] reminder fell back to email", {
    ok: sent.ok,
    reason: sent.reason || null,
  });
  return { sent: sent.ok, kind: "reminder", why: sent.reason || null };
}
