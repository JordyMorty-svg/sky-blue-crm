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

const SERVICE_LABELS = {
  "residential-window-washing": "Residential window washing",
  "commercial-window-washing": "Commercial window washing",
  "gutter-cleaning": "Gutter cleaning",
  "screen-cleaning-repair": "Screen cleaning & repair",
  "pressure-washing": "Pressure washing",
  "solar-panel-cleaning": "Solar panel cleaning",
};

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

function money(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// Anything that reaches an email body gets escaped. The customer name and the
// note are typed by whoever made the quote — on a phone, at a door — and a
// stray angle bracket should not be able to rewrite the markup around it.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function quoteHtml({ customerName, amount, services, note, address, link, expires }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:#2563eb;padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#ffffff;margin:0;font-size:1.4rem;">Sky Blue Cleaning Co.</h1>
      <p style="color:#dbeafe;margin:6px 0 0;font-size:0.9rem;">Your quote</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:24px;">
      <p style="margin:0 0 18px;">Hi ${esc(customerName) || "there"}, thanks for having us out. Here's your quote.</p>

      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        ${address ? `<tr><td style="padding:8px 0;color:#64748b;">Address</td><td style="padding:8px 0;text-align:right;">${esc(address)}</td></tr>` : ""}
        <tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Service</td><td style="padding:8px 0;text-align:right;">${services.map(esc).join("<br/>")}</td></tr>
        <tr><td style="padding:14px 0 0;font-weight:700;font-size:1.15rem;">Total</td><td style="padding:14px 0 0;text-align:right;font-weight:700;font-size:1.15rem;color:#2563eb;">${money(amount)}</td></tr>
      </table>

      ${note ? `<p style="margin:18px 0 0;padding:12px 14px;background:#f8fafc;border-radius:10px;font-size:0.9rem;color:#475569;">${esc(note)}</p>` : ""}

      <div style="text-align:center;margin:26px 0 8px;">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 30px;border-radius:999px;font-weight:700;font-size:1rem;">Accept this quote</a>
      </div>
      <p style="margin:0;text-align:center;font-size:0.8rem;color:#94a3b8;">Good through ${expires}. No deposit required.</p>

      <p style="margin:24px 0 0;font-size:0.85rem;color:#64748b;">
        Every job includes the screens scrubbed and rinsed, plus the sills and tracks.<br/><br/>
        Family-owned, right here in Corvallis.<br/>
        Questions? Just reply to this email.
      </p>
    </div>
  </div>`;
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
      // "sent but never viewed" signal honest.
      status: customerEmail ? "sent" : "draft",
      sent_at: customerEmail ? new Date().toISOString() : null,
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

  // No email address is a normal case, not a failure — most customers added
  // through Add past jobs have none. Text it instead where we can, and hand
  // the link back either way so the CRM can offer it however this went.
  if (!customerEmail) {
    const texted = await textTheQuote({
      quote,
      customerName,
      customerPhone,
      amount: value,
      leadId,
      customerId,
      senderId,
    });

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

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.QUOTE_FROM || process.env.RECEIPT_FROM,
        reply_to:
          process.env.REPLY_TO || process.env.FOLLOW_UP_REPLY_TO || undefined,
        to: [customerEmail],
        subject: `Your Sky Blue Cleaning quote — ${money(value)}`,
        html: quoteHtml({
          customerName,
          amount: value,
          services,
          note,
          address,
          link,
          expires: expiresAt.toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
          }),
        }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Resend error");

    return Response.json({ id: quote.id, token: quote.token, link, emailed: true });
  } catch (err) {
    // The quote EXISTS at this point. Reporting a flat failure would leave a
    // real, valid quote in the database that the user believes never happened
    // — and they'd make a second one. So the link comes back regardless, and
    // the UI offers it as a text instead.
    console.error("Quote saved but email failed:", err);
    return Response.json({
      id: quote.id,
      token: quote.token,
      link,
      emailed: false,
      emailError: err.message,
    });
  }
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
async function textTheQuote({ quote, customerName, customerPhone, amount, leadId, customerId, senderId }) {
  if (!customerPhone) return { ok: false, reason: "no_phone" };

  const result = await sendSms({
    kind: "quote",
    phone: customerPhone,
    body: quoteSms({ customerName, amount, token: quote.token }),
    leadId,
    customerId,
    quoteId: quote.id,
    // A person pressed Send, so quiet hours don't apply. An opt-out still
    // does, and there is no argument that it shouldn't.
    sentBy: senderId,
    force: true,
  });

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
