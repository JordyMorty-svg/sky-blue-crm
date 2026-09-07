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

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

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

// --- talking to Supabase ----------------------------------------------------

// Works with either generation of Supabase key.
//
// The legacy `service_role` key is a JWT, and PostgREST reads the role it
// should act as out of the Authorization header — so that one has to be sent
// twice, as apikey AND as a bearer token.
//
// The newer `sb_secret_...` keys are NOT JWTs, and Supabase's docs are
// explicit that they go on the apikey header ONLY. Sending one as a bearer
// token makes the gateway try to parse it as a JWT and reject the request,
// which would show up as a 401 on every follow-up run with a key that is
// perfectly valid.
//
// Sniffing for the JWT prefix rather than asking which kind it is: there is
// no third option, the check can't go stale, and the legacy keys are being
// retired at the end of 2026 — so this file needs to keep working across a
// swap that happens in the dashboard with no deploy.
function supabaseHeaders(key) {
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// Runs on a schedule with no user logged in, so it uses a key that bypasses
// RLS. That is exactly why nothing here writes to tables directly — every
// call is one of the security-definer functions in db/follow-ups.sql, so the
// rules stay in one place rather than being re-implemented by a caller that
// happens to be able to ignore them.
export async function rpc(fn, body = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set"
    );
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: supabaseHeaders(key),
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    // PostgREST wraps a `raise exception` as
    // {"code":"P0001","message":"Dana has unsubscribed…","details":null}.
    // Those messages are written as sentences for whoever pressed the
    // button, so pull the message out rather than throwing the envelope —
    // otherwise the CRM shows the customer's own name buried in JSON next
    // to an error code that means nothing to anyone.
    let message = "";
    try {
      message = JSON.parse(text)?.message || "";
    } catch {
      message = "";
    }
    throw new Error(message || `${fn}: ${res.status} ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

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

async function sendOne(row, siteUrl) {
  const { subject, html, text } = followUpEmail({
    customerName: row.customer_name,
    services: row.services,
    jobDate: row.job_date,
    customerId: row.customer_id,
    siteUrl,
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FOLLOW_UP_FROM || process.env.RECEIPT_FROM,
      to: [row.email],
      // FOLLOW_UP_REPLY_TO first, then the general REPLY_TO that receipts
      // also read. One address set in either place covers both emails; two
      // only if you want them split.
      reply_to:
        process.env.FOLLOW_UP_REPLY_TO || process.env.REPLY_TO || undefined,
      subject,
      html,
      text,
      // Gmail and Outlook both surface a one-click unsubscribe from these,
      // which keeps complaints off the domain's reputation.
      headers: {
        "List-Unsubscribe": `<${unsubUrl(row.customer_id, siteUrl)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend ${res.status}`);
  return data.id;
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
      would_send: (rows || []).map((r) => ({
        to: r.email,
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
  const results = [];

  for (const row of rows) {
    try {
      const providerId = await sendOne(row, siteUrl);
      await rpc("mark_follow_up_sent", {
        p_id: row.follow_up_id,
        p_provider_id: providerId || null,
        p_email: row.email,
      });
      sent += 1;
      results.push({ to: row.email, name: row.customer_name, ok: true });
    } catch (err) {
      // Never rethrow: one failure must not abandon the rest of the batch,
      // and the row is already claimed — it has to be released or it sits
      // in 'sending' until the sweep.
      await rpc("mark_follow_up_failed", {
        p_id: row.follow_up_id,
        p_error: String(err?.message || err),
      }).catch(() => {});
      failed += 1;
      results.push({
        to: row.email,
        name: row.customer_name,
        ok: false,
        error: String(err?.message || err),
      });
    }
  }

  return { sent, failed, results };
}
