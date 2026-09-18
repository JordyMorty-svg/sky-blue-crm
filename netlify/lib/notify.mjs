// netlify/lib/notify.mjs
//
// Internal notifications to the company inbox. Nobody outside Sky Blue ever
// receives one of these.
//
// Two events are worth an email:
//
//   1. A quote went out — proof it actually left, and a record of what the
//      customer was told, without anybody having to open the CRM.
//   2. A customer ACCEPTED — the one that needs somebody to do something.
//      A quote accepted at 9pm is a job to schedule, and until this existed
//      it sat silently in the database until the next time a person happened
//      to look at the Leads board.
//
// Environment variables (all optional — unset means "don't notify"):
//   NOTIFY_TO    — where these land, e.g. "company@skybluecleaningco.com".
//                  Unset, every function here is a silent no-op.
//   NOTIFY_FROM  — falls back to QUOTE_FROM, then RECEIPT_FROM, so this
//                  works before it is ever set.
//   RESEND_API_KEY — the same key the quote emails already use.
//
// Nothing in this file is allowed to throw or to fail a request. A
// notification is a courtesy on top of work that has already happened: the
// quote is sent, the acceptance is recorded, the commission is credited.
// Failing the customer's Accept button because an internal email bounced
// would be an absurd trade.

import { esc, money, serviceLabels } from "./html.mjs";

const BRAND = "#2563eb";
const GOOD = "#047857";

function to() {
  return (process.env.NOTIFY_TO || "").trim();
}

function from() {
  return process.env.NOTIFY_FROM || process.env.QUOTE_FROM || process.env.RECEIPT_FROM || "";
}

/**
 * Is there anywhere to send one, and anything to send it with?
 *
 * Exported so callers can skip building a body they'd only throw away, and so
 * the health check on /api/send-quote can report it truthfully.
 */
export function notifyConfigured() {
  return Boolean(to() && from() && process.env.RESEND_API_KEY);
}

/**
 * Post one notification. Resolves with { ok, reason } — never rejects.
 *
 * `reason` is recorded rather than surfaced: no screen in the CRM is waiting
 * on this, so the only consumer is the Netlify log, where "why didn't I get
 * an email" gets answered without reproducing anything.
 */
export async function notify({ subject, html }) {
  if (!notifyConfigured()) {
    return { ok: false, reason: to() ? "no_from_or_key" : "no_notify_to" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from(),
        // Split on commas so both brothers can be on it without a second
        // variable. Resend takes an array; a bare string with a comma in it
        // is rejected in a way that reads like a bad API key.
        to: to().split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data?.message || `Resend ${res.status}` };
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

function crmBase() {
  return (process.env.PUBLIC_URL || process.env.URL || "https://crm.skybluecleaningco.com")
    .replace(/\/$/, "");
}

/**
 * A link straight to the record in the CRM.
 *
 * This is the one that is meant to be CLICKED — see the long note in
 * quoteSentNotification about why the customer's own link is not.
 */
function recordUrl({ leadId, customerId }) {
  if (leadId) return `${crmBase()}/leads/${leadId}`;
  if (customerId) return `${crmBase()}/customers/${customerId}`;
  return null;
}

function row(label, value) {
  if (!value) return "";
  return `<tr>
    <td style="padding:7px 0;color:#64748b;font-size:0.9rem;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
    <td style="padding:7px 0 7px 16px;text-align:right;font-size:0.9rem;color:#0f172a;">${value}</td>
  </tr>`;
}

function shell({ accent, eyebrow, heading, body }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:${accent};padding:22px 24px;border-radius:14px 14px 0 0;">
      <p style="color:#ffffff;margin:0;font-size:0.75rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">${esc(eyebrow)}</p>
      <h1 style="color:#ffffff;margin:6px 0 0;font-size:1.3rem;">${esc(heading)}</h1>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:22px 24px;">
      ${body}
    </div>
    <p style="margin:14px 0 0;text-align:center;font-size:0.75rem;color:#94a3b8;">
      Sent by the Sky Blue CRM. Nobody outside the company receives this.
    </p>
  </div>`;
}

/**
 * The link the customer got, shown but deliberately NOT clickable.
 *
 * Opening a quote link is what moves it from 'sent' to 'viewed'. That flag is
 * load-bearing: sms_due_quote_nudges() sends a different chaser for "never
 * opened" than for "opened and didn't accept", and the second one is the
 * valuable message. If Jordan opens his own confirmation email and taps the
 * link to check it looks right, the customer is recorded as having read a
 * quote they have not seen, and gets the wrong follow-up — or, once they do
 * open it, none at all.
 *
 * This is the same reason QuotesPanel has no Preview button. Stating it as
 * plain selectable text keeps the link available for the rare case somebody
 * genuinely needs to resend it by hand, while making the consequence of
 * opening it impossible to stumble into.
 */
function customerLinkBlock(link) {
  if (!link) return "";
  return `
  <p style="margin:18px 0 6px;font-size:0.8rem;color:#64748b;">The link the customer received</p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.75rem;color:#334155;word-break:break-all;user-select:all;">${esc(link)}</div>
  <p style="margin:6px 0 0;font-size:0.75rem;color:#b45309;">Not a link on purpose — opening it marks the quote as read by the customer and changes which follow-up they get.</p>`;
}

/**
 * "Here's the quote you just sent."
 *
 * Only ever built for a quote that actually WENT somewhere. A quote created
 * as a bare link — no email, no text — produces no notification, because
 * "here's the quote you emailed" would be false and the inbox would fill with
 * confirmations of things that never left.
 */
export function quoteSentNotification({
  channel, // "email" | "text"
  customerName,
  customerEmail,
  customerPhone,
  address,
  serviceKeys,
  amount,
  note,
  link,
  expiresAt,
  sentByName,
  leadId,
  customerId,
}) {
  const verb = channel === "text" ? "Texted" : "Emailed";
  const destination = channel === "text" ? customerPhone : customerEmail;
  const record = recordUrl({ leadId, customerId });

  const subject = `${verb} a quote — ${customerName || "a customer"}, ${money(amount)}`;

  const html = shell({
    accent: BRAND,
    eyebrow: `Quote ${verb.toLowerCase()}`,
    heading: `${customerName || "A customer"} — ${money(amount)}`,
    body: `
      <table style="width:100%;border-collapse:collapse;">
        ${row(channel === "text" ? "Texted to" : "Emailed to", esc(destination))}
        ${row("Address", esc(address))}
        ${row("Service", serviceLabels(serviceKeys).map(esc).join("<br/>"))}
        ${row("Total", `<strong style="font-size:1.05rem;color:${BRAND};">${money(amount)}</strong>`)}
        ${row("Good through", esc(expiresAt))}
        ${row("Sent by", esc(sentByName))}
      </table>
      ${
        note
          ? `<p style="margin:16px 0 0;padding:11px 13px;background:#f8fafc;border-radius:10px;font-size:0.85rem;color:#475569;"><span style="color:#94a3b8;">Note on the quote:</span><br/>${esc(note)}</p>`
          : ""
      }
      ${customerLinkBlock(link)}
      ${
        record
          // Bordered, not just tinted. Against the white card a #f1f5f9 fill
          // alone rendered as bold text rather than a button — measured, not
          // guessed: see verify/shot-notify.mjs.
          ? `<div style="margin:22px 0 0;"><a href="${esc(record)}" style="display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700;font-size:0.85rem;">Open in the CRM</a></div>`
          : ""
      }`,
  });

  return { subject, html };
}

/**
 * "They said yes."
 *
 * Visually distinct from the send confirmation on purpose — green, and the
 * subject leads with ACCEPTED — because these two land in the same inbox and
 * only one of them needs somebody to get up and do something.
 *
 * Says who sent the original quote, because that is who the booking fee is
 * credited to, and a commission question is far easier to answer the day it
 * happens than three weeks later from the ledger.
 */
export function quoteAcceptedNotification({
  customerName,
  address,
  serviceKeys,
  amount,
  sentByName,
  leadId,
  customerId,
}) {
  const record = recordUrl({ leadId, customerId });

  const subject = `ACCEPTED — ${customerName || "a customer"}, ${money(amount)}`;

  const html = shell({
    accent: GOOD,
    eyebrow: "Quote accepted",
    heading: `${customerName || "A customer"} accepted — ${money(amount)}`,
    body: `
      <p style="margin:0 0 16px;font-size:0.95rem;color:#0f172a;">
        ${leadId ? "The lead has moved to <strong>Booked</strong>. It needs a day on the schedule." : "Repeat work — it needs a day on the schedule."}
      </p>
      <table style="width:100%;border-collapse:collapse;">
        ${row("Address", esc(address))}
        ${row("Service", serviceLabels(serviceKeys).map(esc).join("<br/>"))}
        ${row("Agreed price", `<strong style="font-size:1.05rem;color:${GOOD};">${money(amount)}</strong>`)}
        ${row("Quoted by", esc(sentByName))}
      </table>
      ${
        record
          ? `<div style="margin:22px 0 0;"><a href="${esc(record)}" style="display:inline-block;background:${GOOD};color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:700;font-size:0.9rem;">Schedule it</a></div>`
          : ""
      }`,
  });

  return { subject, html };
}
