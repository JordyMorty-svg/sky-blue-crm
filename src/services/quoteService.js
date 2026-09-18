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
  // "email" | "text" — chosen in the modal. Omitted, the server falls back to
  // the old behaviour of preferring an email address where there is one.
  channel = null,
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
      channel,
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

/**
 * Every quote ever sent to this PERSON, newest first.
 *
 * Not "every quote on this row". A quote sent while somebody was a lead keeps
 * lead_id and nothing else, so a direct `customer_id = ...` query showed
 * "No quotes sent yet" on the profile of the customer that very quote had
 * won. Worse, one person is often several leads — knocked in spring, called
 * back in autumn — and the quotes on the leads that did NOT convert are
 * exactly the ones worth seeing before quoting them again.
 *
 * quotes_for_contact() resolves the person through contact_identity(), the
 * same function the contact timeline uses, and returns a `from_elsewhere`
 * flag for quotes attached to a different record so the page can say so.
 */
export async function fetchQuotes({ leadId = null, customerId = null }) {
  if (!leadId && !customerId) return [];

  const { data, error } = await supabase.rpc("quotes_for_contact", {
    p_lead_id: leadId,
    p_customer_id: customerId,
  });
  if (error) throw error;

  // The RPC returns a flat sender_name; the panel reads `sender.full_name`,
  // the shape the old embedded select produced. Reshaped here rather than in
  // the component so the component doesn't have to know which it came from.
  return (data || []).map((q) => ({
    ...q,
    sender: q.sender_name ? { full_name: q.sender_name } : null,
  }));
}

/**
 * Is there a quote to offer to send for this freshly created lead?
 *
 * Lives here rather than beside the component that uses it for two reasons.
 * A component file may export only components — fast refresh depends on it —
 * and more usefully, there are two Add lead forms (the New lead page and the
 * pin on the map) that both ask this question. Two copies of it would
 * eventually answer differently.
 */
export function quotable(lead) {
  return Boolean(
    lead &&
      lead.id &&
      // A lead cannot be saved as "quoted" without a price, so by this point
      // a quote genuinely exists — it just exists in somebody's head.
      lead.status === "quoted" &&
      // Nothing to send it to means the modal would open only to say so,
      // which is worse than not offering.
      (lead.email || lead.phone)
  );
}

/**
 * Turn a Supabase error into a sentence someone can act on.
 *
 * The one worth naming is a missing function. The frontend and the database
 * are deployed separately — Netlify on a push, Supabase by hand in the SQL
 * editor — so "the code is ahead of the schema" is a normal state to be in
 * for a few minutes, and it presents as every customer failing at once.
 * PGRST202 is PostgREST's code for exactly that.
 */
export function describeLoadError(e) {
  const code = e?.code || "";
  const message = String(e?.message || e || "");

  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return "Quotes need one more database migration: run db/quote-history.sql in the Supabase SQL editor.";
  }

  // PostgREST reports a permissions problem as an empty result far more often
  // than as an error, so a 401/403 here really is a misconfigured session.
  if (code === "42501" || /permission denied/i.test(message)) {
    return "This account isn't allowed to read quotes. Check the grant on quotes_for_contact.";
  }

  return `Couldn't load past quotes: ${message || "unknown error"}`;
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
