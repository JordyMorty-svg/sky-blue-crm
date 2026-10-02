// netlify/lib/followUps.mjs
//
// The follow-up email: what it says, and the run that sends it.
//
// Lives outside netlify/functions/ on purpose — everything in that folder
// is deployed as its own endpoint, and this is shared code. Two functions
// import it: send-follow-ups.mjs (the daily schedule) and
// run-follow-ups.mjs (the manual "send now" button), so there is one
// implementation and the button genuinely tests the schedule.
//
// Required Netlify environment variables (server-only, no VITE_ prefix):
//   SUPABASE_SERVICE_ROLE_KEY  — Supabase → Settings → API. NOT the anon key.
//   RESEND_API_KEY             — already set for receipts
//   FOLLOW_UPS_MODE            — off | preview | send   (defaults to "off")
//
// Optional:
//   FOLLOW_UP_FROM        — defaults to RECEIPT_FROM
//   REPLY_TO              — where a customer's reply lands, for every email
//                           the CRM sends. FOLLOW_UP_REPLY_TO still works and
//                           wins here, for when review requests should go
//                           somewhere different from receipts.
//   REVIEW_URL            — the Google review link
//   BUSINESS_ADDRESS      — postal address, required on commercial email
//   UNSUBSCRIBE_SECRET    — any random string; signs the opt-out links

import crypto from "node:crypto";
import { sendEmail } from "./email.mjs";
import { sendSms, reviewSms } from "./sms.mjs";

// Jordan's Google Maps listing, with the write-a-review dialog opened
// (that's what the `12e1` in the path does).
//
// Kept overridable because this exact URL is not forever: it carries a
// `g_ep` build token and map coordinates, both of which Google rotates. Two
// sturdier forms if it ever stops opening the review box —
//   https://www.google.com/maps?cid=2356952926519109952   (same listing, permanent)
//   the g.page/r/…/review short link from the Google Business Profile dashboard,
//   which is the one Google actually intends for this
const DEFAULT_REVIEW_URL =
  "https://www.google.com/maps/place//@44.5928853,-123.2438123,17z/data=!3m1!4b1!4m3!3m2!1s0x54c03ff33d83ee6d:0x20b59432f17d2940!12e1?entry=ttu&g_ep=EgoyMDI2MDgyNi4wIKXMDSoASAFQAw%3D%3D";

const reviewUrl = () => process.env.REVIEW_URL || DEFAULT_REVIEW_URL;

/*
 * The same destination, short enough to text.
 *
 * The URL above is 230 characters. In an email that is invisible, because it
 * hides behind a button. In a text it IS the message: it would take the
 * review request to three segments on its own, and a wall of punctuation in
 * a message from an unknown number is what a scam looks like.
 *
 * The `cid` form is the same listing by its permanent id — no coordinates,
 * no rotating build token, 47 characters. It opens the Business Profile with
 * the review button right there rather than the write-a-review box itself,
 * which is one extra tap and worth it.
 *
 * REVIEW_URL_SMS overrides it, and the thing to put there is the
 * `g.page/r/…/review` short link from the Google Business Profile dashboard:
 * short AND straight into the review box. It isn't the default only because
 * it can't be derived — somebody has to copy it out of the dashboard.
 */
const DEFAULT_REVIEW_URL_SMS = "https://maps.google.com/?cid=2356952926519109952";

const reviewUrlSms = () =>
  process.env.REVIEW_URL_SMS || DEFAULT_REVIEW_URL_SMS;

// --- talking to Supabase ----------------------------------------------------
//
// Moved to netlify/lib/db.mjs. Re-exported here because sms.mjs, smsRun.mjs
// and sms-inbound.mjs all import rpc from this module, and a rename that
// touches four files to move fifteen lines is a rename that breaks one of
// them.
//
// IMPORTED as well as re-exported, and that is not redundant.
//
// `export { x } from "y"` is a re-export: it forwards the name to anyone
// importing THIS module, and puts nothing in this module's own scope. The
// six rpc() calls below are local calls, so with only the re-export every
// one of them threw `ReferenceError: rpc is not defined` — which is exactly
// what the CRM showed when somebody pressed "Send review request".
//
// This is the second time this bug shipped in one afternoon; sms-inbound.mjs
// had it too. See verify/module-bindings.mjs, which now fails the build for
// it.
import { rpc, supabaseHeaders } from "./db.mjs";
export { rpc, supabaseHeaders };

// --- the unsubscribe link ---------------------------------------------------
//
// A review request is commercial email, so CAN-SPAM applies: it needs a
// working opt-out and a postal address. Both are below. This is not
// optional polish — sending without them is the actual illegal version.

export function unsubToken(customerId) {
  const secret = process.env.UNSUBSCRIBE_SECRET || "sky-blue-dev-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(String(customerId))
    .digest("base64url")
    .slice(0, 24);
}

// Signed rather than just the raw customer id: a customer id on its own
// would let anyone holding an exported list opt every customer out.
export function unsubUrl(customerId, siteUrl) {
  const base = (siteUrl || process.env.URL || "https://crm.skybluecleaningco.com")
    .replace(/\/$/, "");
  return `${base}/api/email-opt-out?c=${customerId}&t=${unsubToken(customerId)}`;
}

// --- the email --------------------------------------------------------------

function prettyDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// First name only. "Hi Jordan" reads like a person; "Hi Jordan Mortensen"
// reads like a mail merge, which is what this is and shouldn't sound like.
function firstName(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first || "there";
}

// Belt and braces on interpolation: these values come from the CRM, where
// somebody will eventually type an ampersand into a customer name.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function followUpEmail({ customerName, services, jobDate, customerId, siteUrl }) {
  const name = esc(firstName(customerName));
  const when = prettyDate(jobDate);
  const what = esc(services || "your window cleaning");
  const review = esc(reviewUrl());
  const unsub = esc(unsubUrl(customerId, siteUrl));
  const postal = esc(process.env.BUSINESS_ADDRESS || "Corvallis, Oregon");

  const subject = "How did we do?";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:#2563eb;padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#ffffff;margin:0;font-size:1.4rem;">Sky Blue Cleaning Co.</h1>
      <p style="color:#dbeafe;margin:6px 0 0;font-size:0.9rem;">Thanks for having us out</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:24px;">
      <p style="margin:0 0 16px;font-size:1rem;line-height:1.55;">
        Hi ${name}, we took care of ${what.toLowerCase()}${when ? ` on ${esc(when)}` : ""}.
        Hope the place is looking brighter.
      </p>

      <p style="margin:0 0 20px;font-size:1rem;line-height:1.55;">
        If you thought we did a good job, please leave us a Google review —
        we're a small family business and reviews are how most people find us.
        It takes about a minute.
      </p>

      <p style="margin:0 0 24px;text-align:center;">
        <a href="${review}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:999px;">
          Leave a Google review
        </a>
      </p>

      <p style="margin:0 0 4px;font-size:0.95rem;line-height:1.55;color:#334155;">
        And if anything wasn't right, just reply to this email and we'll come
        back out and fix it. We'd rather hear it from you than read it later.
      </p>

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;" />

      <p style="margin:0 0 10px;font-size:0.85rem;color:#64748b;line-height:1.5;">
        Family-owned. No fake stats. Just clean.<br/>
        ${postal}
      </p>
      <p style="margin:0;font-size:0.78rem;color:#94a3b8;line-height:1.5;">
        <a href="${unsub}" style="color:#94a3b8;">Unsubscribe from follow-up emails</a>
        — you'll still get receipts and appointment details.
      </p>
    </div>
  </div>`;

  // Plain-text alternative. Some clients show it, spam filters read it, and
  // an HTML-only email scores worse for deliverability.
  const text = [
    `Hi ${firstName(customerName)}, we took care of ${(services || "your window cleaning").toLowerCase()}${when ? ` on ${when}` : ""}. Hope the place is looking brighter.`,
    ``,
    `If you thought we did a good job, please leave us a Google review — we're a small family business and reviews are how most people find us:`,
    reviewUrl(),
    ``,
    `And if anything wasn't right, just reply to this email and we'll come back out and fix it.`,
    ``,
    `Sky Blue Cleaning Co.`,
    process.env.BUSINESS_ADDRESS || "Corvallis, Oregon",
    ``,
    `Unsubscribe from follow-up emails: ${unsubUrl(customerId, siteUrl)}`,
  ].join("\n");

  return { subject, html, text };
}

// --- sending ----------------------------------------------------------------

/*
 * Reasons a text didn't go that are nothing to do with the customer.
 *
 * SMS_MODE off or in preview, Quo not configured, db/sms.sql not run, or
 * simply before 9am. Every one of them means "not now" and none of them
 * means "this person cannot be asked" — so they put the row back in the
 * queue untouched instead of spending one of its three attempts.
 *
 * Without this, three quiet mornings in a row would mark a customer
 * 'skipped' forever, and the note would say 'quiet_hours', and nobody would
 * ever look.
 */
const NOT_NOW = new Set([
  "sms_off",
  "preview",
  "not_configured",
  "no_sms_tables",
  "quiet_hours",
]);

class Deferred extends Error {
  constructor(reason) {
    super(reason);
    this.deferred = true;
  }
}

/*
 * The text version.
 *
 * Deliberately NOT force: true. The acknowledgment text in ack-leads.mjs
 * forces past quiet hours because it is a reply to somebody who messaged us
 * sixty seconds ago — they are awake and waiting. Nobody is waiting for
 * this. A review request at 7am is the most reliable way there is to turn a
 * happy customer into a one-star one.
 */
async function textOne(row) {
  const body = reviewSms({
    customerName: row.customer_name,
    reviewUrl: reviewUrlSms(),
  });

  const result = await sendSms({
    kind: "review",
    phone: row.phone,
    body,
    customerId: row.customer_id,
    // Both so the outbox row is tied to the job, which is also what makes
    // the dedupe key 'review:j:<job>' resolve — the database constraint that
    // makes a second text for one job impossible.
    jobId: row.job_id || null,
  });

  if (!result.ok) {
    if (NOT_NOW.has(result.reason)) throw new Deferred(result.reason);
    throw new Error(result.reason || "Quo error");
  }

  // The Quo message id, stored in the same column a Resend id goes in.
  // Different provider, same question it answers: which message was this.
  return result.sid || null;
}

async function sendOne(row, siteUrl) {
  // The database decided this, three days after the job, with the opt-outs
  // and the phone number in front of it. The sender does not get a vote —
  // re-deriving it here is how the preview and the real run drift apart.
  if (row.channel === "sms") return textOne(row);
  return emailOne(row, siteUrl);
}

async function emailOne(row, siteUrl) {
  const { subject, html, text } = followUpEmail({
    customerName: row.customer_name,
    services: row.services,
    jobDate: row.job_date,
    customerId: row.customer_id,
    siteUrl,
  });

  // Through sendEmail() rather than its own fetch, so this is recorded and
  // a bounce on it shows up in the CRM's failures list like everything else.
  // Before this, a review request to a dead address was the most invisible
  // email the business sent: nobody is waiting for a reply to one, so there
  // was nothing to notice.
  const result = await sendEmail({
    kind: "follow_up",
    to: row.email,
    subject,
    html,
    text,
    from: process.env.FOLLOW_UP_FROM || process.env.RECEIPT_FROM,
    // FOLLOW_UP_REPLY_TO first, then the general REPLY_TO that receipts
    // also read. One address set in either place covers both emails; two
    // only if you want them split.
    replyTo: process.env.FOLLOW_UP_REPLY_TO || process.env.REPLY_TO || undefined,
    // Gmail and Outlook both surface a one-click unsubscribe from these,
    // which keeps complaints off the domain's reputation.
    headers: {
      "List-Unsubscribe": `<${unsubUrl(row.customer_id, siteUrl)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    customerId: row.customer_id,
    jobId: row.job_id || null,
  });

  // Thrown, not returned, because deliver() above is built around a throw:
  // it releases the claimed row and records the reason in the catch. A
  // silent false here would mark the follow-up sent and it would never go.
  if (!result.ok) {
    throw new Error(
      result.skipped === "unreachable"
        ? `not sent: ${result.reason}`
        : result.reason || "Resend error"
    );
  }

  return result.id;
}

/**
 * One pass of the queue.
 *
 * mode:
 *   "off"     — do nothing at all. THE DEFAULT, deliberately: deploying
 *               this code must not start emailing customers. Turning it on
 *               is a separate, conscious act.
 *   "preview" — work out exactly who would be emailed and log it, touching
 *               nothing. Rows stay pending, so flipping to "send" later
 *               sends them.
 *   "send"    — for real.
 */
export async function runFollowUps({ mode, limit = 25, siteUrl } = {}) {
  const chosen = mode || process.env.FOLLOW_UPS_MODE || "off";

  if (chosen === "off") {
    return { mode: chosen, swept: 0, sent: 0, failed: 0, note: "FOLLOW_UPS_MODE is off" };
  }

  if (chosen === "preview") {
    const rows = await rpc("preview_follow_ups", { p_limit: limit });
    return {
      mode: chosen,
      swept: 0,
      sent: 0,
      failed: 0,
      // `via` and the right destination per row. A preview that printed an
      // email column for everyone would quietly hide the whole point of
      // this change — that some of these are now going out as texts.
      would_send: (rows || []).map((r) => ({
        to: r.channel === "sms" ? r.phone : r.email,
        via: r.channel,
        name: r.customer_name,
        due: r.due_at,
      })),
    };
  }

  // Close out anything that can no longer legitimately go, and release
  // claims from a run that died, BEFORE claiming anything new.
  const swept = await rpc("sweep_follow_ups");

  const rows = (await rpc("claim_follow_ups", { p_limit: limit })) || [];

  const outcome = await deliver(rows, siteUrl);
  return { mode: chosen, swept, claimed: rows.length, ...outcome };
}

/**
 * Send a review request to ONE named customer, right now.
 *
 * Deliberately shares deliver() with the scheduled run rather than having a
 * send path of its own — this is the button people will actually use to
 * check the emails are working, and a test that exercises different code
 * from the thing it is testing is worse than no test.
 *
 * FOLLOW_UPS_MODE is not consulted. "Off" means the automation shouldn't act
 * unprompted; it was never meant to stop a person sending an email on
 * purpose. The database still refuses an unsubscribed customer.
 */
export async function sendFollowUpToCustomer(customerId, { siteUrl } = {}) {
  const rows = (await rpc("claim_manual_follow_up", {
    p_customer_id: customerId,
  })) || [];

  // claim_manual_follow_up raises rather than returning nothing when it
  // refuses, so an empty result here means the customer vanished between
  // the page loading and the button being pressed.
  if (rows.length === 0) {
    throw new Error("That customer couldn't be found any more.");
  }

  const outcome = await deliver(rows, siteUrl);
  return { mode: "manual", claimed: rows.length, ...outcome };
}

/**
 * Put the claimed rows in the post.
 *
 * Serial, not Promise.all. The volume is a handful a day, Resend rate
 * limits, and one bad address shouldn't take a batch down with it.
 */
async function deliver(rows, siteUrl) {
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  const results = [];

  for (const row of rows) {
    // Where it actually went. sent_to is "the address as it was at send
    // time", and for a text that is the number — logging the email column
    // for an SMS row would put an empty string in the one field that answers
    // "who did we contact?".
    const to = row.channel === "sms" ? row.phone : row.email;

    try {
      const providerId = await sendOne(row, siteUrl);
      await rpc("mark_follow_up_sent", {
        p_id: row.follow_up_id,
        p_provider_id: providerId || null,
        p_email: to,
        // Decides whether a contact_log row is written here. For a text,
        // mark_sms_sent already wrote one with the actual words in it, and
        // two rows for one message is the duplicate-history bug again.
        p_channel: row.channel || "email",
      });
      sent += 1;
      results.push({ to, via: row.channel, name: row.customer_name, ok: true });
    } catch (err) {
      // Never rethrow: one failure must not abandon the rest of the batch,
      // and the row is already claimed — it has to be released or it sits
      // in 'sending' until the sweep.
      const why = String(err?.message || err);

      if (err?.deferred) {
        await rpc("mark_follow_up_deferred", {
          p_id: row.follow_up_id,
          p_reason: why,
        }).catch(() => {});
        deferred += 1;
        results.push({ to, via: row.channel, name: row.customer_name, deferred: why });
        continue;
      }

      await rpc("mark_follow_up_failed", {
        p_id: row.follow_up_id,
        p_error: why,
      }).catch(() => {});
      failed += 1;
      results.push({
        to,
        via: row.channel,
        name: row.customer_name,
        ok: false,
        error: why,
      });
    }
  }

  return { sent, failed, deferred, results };
}
