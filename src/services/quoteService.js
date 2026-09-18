import { supabase } from "../supabaseClient";
import { SERVICE_TYPES } from "./leadService";

/**
 * Sending quotes, and getting them back.
 *
 * The quote row itself is written server-side by /api/send-quote — not from
 * here. That is deliberate: the row records WHO sent it, and that field
 * decides who gets paid the booking fee when the customer accepts. Letting
 * the browser supply it would make the commission ledger take a rep's word
 * for who they are.
 */

// Derived from the lead service list rather than restated, so a quote can
// never offer a service the rest of the CRM doesn't know about — and so a
// lead's recorded service can be carried straight into a quote by key.
//
// (netlify/functions/send-quote.mjs keeps its own copy of these labels on
// purpose: it runs on the server, where importing anything under src/ would
// drag in the browser Supabase client and import.meta.env. The list is short
// and frozen; that file says the same.)
export const SERVICE_OPTIONS = SERVICE_TYPES.map(({ key, label }) => ({
  key,
  label,
}));

export const SERVICE_LABELS = Object.fromEntries(
  SERVICE_TYPES.map(({ key, label }) => [key, label])
);

/**
 * Create a quote, and deliver it however we can.
 *
 * Email if there's an address; text if there's only a number; otherwise hand
 * back the link. Resolves with `{ link, emailed, texted, textReason }` in
 * every case.
 *
 * `emailed: false, texted: false` is a normal outcome, not a failure — and
 * `textReason` says which normal outcome it was, because "opted_out" and
 * "texting is switched off" need different things from the person reading
 * the screen. A quote that exists but reports failure is worse than one that
 * says "send this yourself": the first makes people create a second quote
 * for the same job.
 */
export async function sendQuote({
  leadId = null,
  customerId = null,
  customerName,
  customerEmail = null,
  // Sent so the server can TEXT the quote when there is no email address.
  // The browser never talks to Quo directly — the API key would be in the
  // bundle, and the send has to be claimed and logged server-side anyway.
  customerPhone = null,
  address = null,
  serviceKeys = [],
  amount,
  note = null,
  expiresInDays = 30,
}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/send-quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      leadId,
      customerId,
      customerName,
      customerEmail,
      customerPhone,
      address,
      serviceKeys,
      amount,
      note,
      expiresInDays,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Couldn't send the quote.");
  return data;
}

// Every quote ever sent to this lead or customer, newest first. Shown on the
// record so you can see at a glance that one is already out — and whether it
// was opened — before sending another.
export async function fetchQuotes({ leadId = null, customerId = null }) {
  let query = supabase
    .from("quotes")
    .select(
      "id, token, amount, status, service_keys, note, created_at, sent_at, viewed_at, accepted_at, expires_at, sender:sent_by ( full_name )"
    )
    .order("created_at", { ascending: false });

  if (leadId) query = query.eq("lead_id", leadId);
  else if (customerId) query = query.eq("customer_id", customerId);
  else return [];

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * What a quote's state means in words, and whether it's still live.
 *
 * Expiry is computed here rather than stored, matching sb_quote_public. A
 * nightly job to flip expired quotes is a cron that can fail; a date
 * comparison cannot.
 */
export function quoteState(q) {
  const expired = new Date(q.expires_at) < new Date();

  if (q.status === "accepted") {
    return { key: "accepted", label: "Accepted", tone: "good" };
  }
  if (q.status === "declined") {
    return { key: "declined", label: "Declined", tone: "bad" };
  }
  if (expired) {
    return { key: "expired", label: "Expired", tone: "muted" };
  }
  if (q.status === "viewed") {
    // The most actionable state in the list: they looked and didn't accept.
    // That's a text, not another email.
    return { key: "viewed", label: "Opened, not accepted", tone: "warn" };
  }
  if (q.status === "sent") {
    return { key: "sent", label: "Sent, not opened yet", tone: "info" };
  }
  return { key: "draft", label: "Link created, not sent", tone: "muted" };
}

// The message you paste into Messages when there's no email on file. Written
// the way Jordan actually texts — short, no salesy padding, the link last so
// it's the thing under their thumb.
export function smsText({ customerName, amount, link }) {
  const first = String(customerName || "").trim().split(/\s+/)[0] || "there";
  return (
    `Hey ${first}, it's Jordan with Sky Blue Cleaning. ` +
    `Here's your quote for $${Number(amount).toFixed(0)} — ` +
    `screens and sills included. You can accept it here: ${link}`
  );
}

// tel:/sms: links want digits only. A number stored as (541) 730-3593 becomes
// 15417303593; anything already in that shape is left alone.
export function smsHref(phone, body) {
  const digits = String(phone || "").replace(/\D/g, "");
  const to = digits.length === 10 ? `1${digits}` : digits;
  // `&body=` is what iOS honours when a number is present; Android accepts
  // both. Without the ?/& distinction the body is silently dropped on iOS.
  return `sms:${to}${to ? "&" : "?"}body=${encodeURIComponent(body)}`;
}

export function money(n) {
  return `$${Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
