// netlify/functions/send-quote.mjs
//
// Creates a quote and, when there's an address to send it to, emails it.
//
// Required Netlify environment variables (server-only, no VITE_ prefix):
//   RESEND_API_KEY        — from resend.com
//   SUPABASE_SERVICE_KEY  — service role; needed because the quote row is
//                           written on the caller's behalf after their token
//                           has been verified. SUPABASE_SERVICE_ROLE_KEY is
//                           accepted too — the rest of netlify/lib uses that
//                           spelling, and only one of them needs to be set.
//
// Optional:
//   QUOTE_FROM   — e.g. "Sky Blue Cleaning Co. <quotes@skybluecleaningco.com>"
//                  Falls back to RECEIPT_FROM so quotes send correctly before
//                  this is ever set.
//   REPLY_TO     — where a reply lands. A customer replying to a quote is
//                  usually saying yes, so this must be an inbox someone reads,
//                  never the sending address.
//   PUBLIC_URL   — base for the quote link. Falls back to the request's own
//                  origin, which is right in every normal deployment.
//
// When there is no email address but there IS a phone number, the quote is
// TEXTED instead — see netlify/lib/sms.mjs for the Quo credentials that needs,
// and note that SMS_MODE defaults to "off", so this does nothing until it is
// deliberately switched on.

import { sendSms, quoteSms } from "../lib/sms.mjs";
import { SERVICE_LABELS } from "../lib/html.mjs";
import { emailTheQuote } from "../lib/quoteEmail.mjs";
import { notify, notifyConfigured, quoteSentNotification } from "../lib/notify.mjs";

// Identifies the caller AND tells us who they are — the quote has to record a
// sender, because that is who gets the booking fee when the customer accepts
// it themselves. A verified-but-anonymous caller isn't enough here.
async function whoIs(req) {
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return null;
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user?.id || null;
}

// Either spelling. This file was written against SUPABASE_SERVICE_KEY;
// netlify/lib/followUps.mjs — which sms.mjs now borrows its Supabase helper
// from — reads SUPABASE_SERVICE_ROLE_KEY. With only one of them set, the
// quote would save and the text would silently fail to claim, which is a
// miserable thing to debug. Accepting both costs one line.
const SERVICE_KEY = () =>
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function db(path, method, body) {
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Supabase ${res.status}`);
  return data;
}

/**
 * Who sent this, by name.
 *
 * Only ever used in the internal notification, so a failure here must not
 * matter: "Emailed a quote — sent by (unknown)" is a perfectly useful email,
 * and failing the send because a profile lookup 500'd would not be.
 */
async function senderName(senderId) {
  if (!senderId) return null;
  try {
    const rows = await db(
      `profiles?id=eq.${encodeURIComponent(senderId)}&select=full_name`,
      "GET"
    );
    return (Array.isArray(rows) ? rows[0] : rows)?.full_name || null;
  } catch (err) {
    console.error("Couldn't read the sender's name:", err);
    return null;
  }
}


/**
 * How this quote goes out.
 *
 * It is the SENDER's decision, not a rule this file applies. It used to be a
 * rule: an email address won, always, and a customer who had both never got
 * a text. That is wrong more often than it is right — a price and a link are
 * read on a phone in a driveway, while an email waits until somebody is at a
 * desk. The old precedence survives only as the DEFAULT for a caller that
 * doesn't say, which keeps an older client working.
 *
 * `useEmail` is separate from the choice because a caller can ask for an
 * email on a record that has no address — a stale form, a client that has
 * not reloaded — and inventing one is not an option. Asked for an email we
 * cannot send, it falls back to the link rather than failing the request.
 */
export function chooseChannel({ channel, customerEmail }) {
  const wanted =
    channel === "email" || channel === "text"
      ? channel
      : customerEmail
        ? "email"
        : "text";
  return { wanted, useEmail: wanted === "email" && Boolean(customerEmail) };
}

/**
 * Which server-side settings this function needs, and whether they are there.
 *
 * Exists because the failure it catches is invisible from the browser: a
 * missing SUPABASE_SERVICE_KEY makes the insert 401 at the gateway, which
 * surfaced as "Couldn't save the quote" with no hint that the cause was a
 * blank field in the Netlify dashboard rather than anything in the code.
 *
 * Values are never returned — only whether each name is set.
 */
function configReport() {
  return {
    supabase_url: Boolean(process.env.VITE_SUPABASE_URL),
    supabase_anon_key: Boolean(process.env.VITE_SUPABASE_ANON_KEY),
    // Either spelling is fine; see SERVICE_KEY() above.
    supabase_service_key: Boolean(SERVICE_KEY()),
    resend_api_key: Boolean(process.env.RESEND_API_KEY),
    quote_from: Boolean(process.env.QUOTE_FROM || process.env.RECEIPT_FROM),
    reply_to: Boolean(process.env.REPLY_TO || process.env.FOLLOW_UP_REPLY_TO),
    quo_api_key: Boolean(process.env.QUO_API_KEY),
    quo_from: Boolean(process.env.QUO_FROM),
    sms_mode: process.env.SMS_MODE || "off",
    // Whether a copy of each sent quote reaches the company inbox. Reported
    // because "I stopped getting the confirmation emails" is otherwise
    // indistinguishable from "no quotes have been sent", and one of those is
    // a blank field in the Netlify dashboard.
    notify_to: Boolean(process.env.NOTIFY_TO),
    notify_ready: notifyConfigured(),
  };
}

export default async (req) => {
  const senderId = await whoIs(req);
  if (!senderId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // GET is a health check, behind the same login as everything else. Answers
  // "is this configured?" without sending anybody a quote to find out.
  if (req.method === "GET") {
    return Response.json({ ok: true, config: configReport() });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Checked before anything is built, so the message names the actual
  // problem instead of surfacing as a failed insert.
  if (!SERVICE_KEY() || !process.env.VITE_SUPABASE_URL) {
    const missing = [
      !process.env.VITE_SUPABASE_URL && "VITE_SUPABASE_URL",
      !SERVICE_KEY() && "SUPABASE_SERVICE_KEY",
    ].filter(Boolean);
    console.error("send-quote is missing configuration:", missing);
    return Response.json(
      {
        error: `The server is missing ${missing.join(" and ")}. Add it in Netlify → Site configuration → Environment variables, then redeploy.`,
        config: configReport(),
      },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const {
    leadId = null,
    customerId = null,
    customerName,
    customerEmail = null,
    customerPhone = null,
    // "email" | "text". Which way this one goes out.
    channel = null,
    address = null,
    serviceKeys = [],
    amount,
    note = null,
    expiresInDays = 30,
  } = body;

  if (!leadId && !customerId) {
    return Response.json({ error: "A quote needs a lead or a customer" }, { status: 400 });
  }
  if (!customerName) {
    return Response.json({ error: "A quote needs a name" }, { status: 400 });
  }
  // Rejected rather than coerced. A quote for NaN would insert as null and
  // fail a not-null constraint with a message nobody can act on.
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    return Response.json({ error: "A quote needs a price" }, { status: 400 });
  }

  const expiresAt = new Date(
    Date.now() + Math.max(1, Number(expiresInDays) || 30) * 86400000
  );

  const { useEmail } = chooseChannel({ channel, customerEmail });

  let quote;
  try {
    // The token is generated by the column default — 32 random bytes from
    // pgcrypto. Deliberately not generated here: one source of randomness,
    // and it can't be weakened by a caller passing their own.
    const rows = await db("quotes", "POST", {
      lead_id: leadId,
      customer_id: customerId,
      customer_name: customerName,
      address,
      service_keys: serviceKeys,
      amount: value,
      note,
      sent_by: senderId,
      expires_at: expiresAt.toISOString(),
      // 'sent' only if we're actually emailing it. A quote handed over as a
      // copied link is 'draft' until the page is opened, which keeps the
      // "sent but never viewed" signal honest. The text path patches this to
      // 'sent' itself, once the text has actually gone.
      status: useEmail ? "sent" : "draft",
      sent_at: useEmail ? new Date().toISOString() : null,
    });
    quote = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    console.error("Couldn't save the quote:", err);
    // The real reason, not a generic sentence. Everyone who can reach this
    // endpoint is a signed-in member of staff, so there is nothing to
    // protect by hiding a Postgres message from them — and "new row
    // violates row-level security policy" tells you in five seconds what
    // "Couldn't save the quote" hides for an evening.
    return Response.json(
      {
        error: `Couldn't save the quote: ${String(err?.message || err)}`,
        config: configReport(),
      },
      { status: 500 }
    );
  }

  const origin = process.env.PUBLIC_URL || new URL(req.url).origin;
  const link = `${origin}/q/${quote.token}`;

  /*
   * Whose name goes on it.
   *
   * Resolved ONCE here, not at each of the three places that need it: the
   * text, the email and the internal notification. It was already being
   * looked up for the notification, so this is the same round trip serving
   * everybody instead of three of them — and, more to the point, it means
   * the customer and the inbox cannot end up being told different names.
   *
   * Null is a fine answer. The templates fall back to the company name.
   */
  const sentByName = await senderName(senderId);

  // Not emailing is a normal case, not a failure — either there is no address
  // or the sender chose to text. Text it where we can, and hand the link back
  // either way so the CRM can offer it however this went.
  const expiresLabel = expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });

  /**
   * Tell the company inbox that a quote went out.
   *
   * Awaited rather than fired and forgotten: a Netlify function's process can
   * be torn down the moment it returns a response, and a background fetch
   * that has not resolved by then simply never happens — which would make
   * this work locally and silently do nothing in production.
   *
   * The cost is a few hundred milliseconds on a request that has already done
   * the slow part. The alternative is a feature whose entire purpose is to be
   * reliable, being unreliable.
   */
  async function announceSent(channel) {
    if (!notifyConfigured()) return;
    const { subject, html } = quoteSentNotification({
      channel,
      customerName,
      customerEmail,
      customerPhone,
      address,
      serviceKeys,
      amount: value,
      note,
      // Deliberately no `link` — see the note in netlify/lib/notify.mjs.
      expiresAt: expiresLabel,
      sentByName,
      leadId,
      customerId,
    });
    const sent = await notify({ subject, html });
    if (!sent.ok) {
      // Logged, never surfaced. The customer has their quote; an internal
      // copy that didn't arrive is not something to fail the request over,
      // and not something the person who pressed Send can fix from there.
      console.error("[send-quote:notify]", JSON.stringify({ quote: quote.id, reason: sent.reason }));
    }
  }

  if (!useEmail) {
    const texted = await textTheQuote({
      quote,
      customerName,
      customerPhone,
      amount: value,
      leadId,
      customerId,
      senderId,
      sentByName,
    });

    // Only when it actually went. A quote that fell back to a copied link was
    // not "texted to the customer", and saying so would make the inbox a
    // record of things that never left.
    if (texted.ok) await announceSent("text");

    return Response.json({
      id: quote.id,
      token: quote.token,
      link,
      emailed: false,
      texted: texted.ok,
      // Named rather than swallowed. "Couldn't text it" with no reason sends
      // somebody looking through Netlify logs; "they replied STOP" is an
      // answer they can act on without leaving the page.
      textReason: texted.ok ? null : texted.reason,
    });
  }

  const services = (serviceKeys.length ? serviceKeys : ["residential-window-washing"]).map(
    (k) => SERVICE_LABELS[k] || k
  );

  /*
   * Through the shared sender, not a fetch written out again here.
   *
   * This function used to post to Resend itself, with its own copy of the
   * from address, the reply-to chain and the subject line — while
   * netlify/lib/quoteEmail.mjs held a second copy for the delivery webhook's
   * "the text was refused, email it instead" path. Two copies of the same
   * email is how a customer gets a quote that looks one way when a person
   * sends it and another way when the CRM does, and it is also two places to
   * remember when the send has to start being recorded.
   */
  const mailed = await emailTheQuote({
    to: customerEmail,
    customerName,
    amount: value,
    services,
    note,
    address,
    link,
    expires: expiresLabel,
    sentByName,
    leadId,
    customerId,
    quoteId: quote.id,
    sentBy: senderId,
    // A person is standing there having just pressed Send. If the address is
    // on the closed list they may well know something it doesn't — they just
    // spoke to the customer, or corrected the address in front of them.
    force: true,
  });

  if (mailed.ok) {
    await announceSent("email");
    return Response.json({ id: quote.id, token: quote.token, link, emailed: true });
  }

  // The quote EXISTS at this point. Reporting a flat failure would leave a
  // real, valid quote in the database that the user believes never happened
  // — and they'd make a second one. So the link comes back regardless, and
  // the UI offers it as a text instead.
  console.error("Quote saved but email failed:", mailed.reason);
  return Response.json({
    id: quote.id,
    token: quote.token,
    link,
    emailed: false,
    emailError: mailed.reason,
  });
};


/**
 * Text a quote that has no email address to go to.
 *
 * Two things have to happen together, and the order matters:
 *
 *   1. The text goes out.
 *   2. The quote moves from 'draft' to 'sent'.
 *
 * Step 2 is not bookkeeping. sms_due_quote_nudges() only ever chases quotes
 * in 'sent' or 'viewed' — a texted quote left as a draft would go out once
 * and then never be followed up, which is the single most valuable thing
 * this whole feature does.
 *
 * Resolves rather than throwing, always. The quote already exists and the
 * link is already on its way back to the browser; a failure here means the
 * rep texts it by hand, not that anything is lost.
 */
async function textTheQuote({
  quote,
  customerName,
  customerPhone,
  amount,
  leadId,
  customerId,
  senderId,
  sentByName,
}) {
  if (!customerPhone) return { ok: false, reason: "no_phone" };

  const result = await sendSms({
    kind: "quote",
    phone: customerPhone,
    body: quoteSms({ customerName, amount, token: quote.token, sentByName }),
    leadId,
    customerId,
    quoteId: quote.id,
    // A person pressed Send, so quiet hours don't apply. An opt-out still
    // does, and there is no argument that it shouldn't.
    sentBy: senderId,
    force: true,
  });

  // Logged either way. "It didn't text them" is answerable from the Netlify
  // function log without reproducing it, which is the only place the reason
  // exists once the browser has moved on.
  console.log(
    "[send-quote:text]",
    JSON.stringify({
      quote: quote.id,
      ok: result.ok,
      reason: result.reason || null,
      mode: process.env.SMS_MODE || "off",
      configured: Boolean(process.env.QUO_API_KEY && process.env.QUO_FROM),
    })
  );

  if (!result.ok) return result;

  try {
    await db(`quotes?id=eq.${quote.id}`, "PATCH", {
      status: "sent",
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    // The text has already gone. Saying so in the log and reporting success
    // is the honest answer: the customer has the quote, and the worst case
    // is that it is never automatically chased.
    console.error("Texted the quote but couldn't mark it sent:", err);
  }

  return result;
}

export const config = {
  path: "/api/send-quote",
};
