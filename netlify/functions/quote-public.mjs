// netlify/functions/quote-public.mjs
//
// The only door a customer touches. No login, no Supabase client in their
// browser, no anon key doing anything on their behalf.
//
//   GET  /api/quote/:token   -> the quote, or 404
//   POST /api/quote/:token   -> accept it
//
// Why this exists rather than letting the page query Supabase directly:
// the anon key is public, so any RLS policy permissive enough to serve a
// logged-out customer is permissive enough to serve anyone who opens dev
// tools. Routing through here means `quotes` stays staff-only in the
// database and the service key never leaves the server.
//
// Required Netlify environment variables:
//   SUPABASE_SERVICE_KEY  — service role (SUPABASE_SERVICE_ROLE_KEY accepted)
//
// Optional:
//   NOTIFY_TO  — the company inbox gets an email the moment a quote is
//                accepted. Unset, nothing is sent and nothing breaks.
//
// Both handlers call SECURITY DEFINER functions (sb_quote_public,
// sb_accept_quote) rather than reading the table: the narrow, deliberately
// chosen column list lives in SQL, next to the data, where it can be
// reviewed in one place instead of trusted to every caller.

import { notify, notifyConfigured, quoteAcceptedNotification } from "../lib/notify.mjs";

// Either spelling, matching send-quote.mjs. This file was written against
// SUPABASE_SERVICE_KEY alone, which meant a deployment that set only
// SUPABASE_SERVICE_ROLE_KEY — the name everything under netlify/lib uses —
// would send quotes perfectly and then 500 on every customer who opened one.
const SERVICE_KEY = () =>
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers() {
  return {
    apikey: SERVICE_KEY(),
    Authorization: `Bearer ${SERVICE_KEY()}`,
    "Content-Type": "application/json",
  };
}

async function rpc(fn, args) {
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Supabase ${res.status}`);
  return data;
}

async function select(path) {
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/${path}`, {
    headers: headers(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Supabase ${res.status}`);
  return data;
}

/**
 * Tell the company inbox that somebody just said yes.
 *
 * Everything here is best-effort and swallowed. This runs on the customer's
 * Accept tap: the acceptance is already committed, the lead is already
 * Booked, and the commission is already credited. Nothing that happens after
 * that point is allowed to show the customer an error.
 *
 * It IS awaited, though, and that is a deliberate trade. A Netlify function
 * can be torn down as soon as it responds, so a background send would work in
 * testing and silently vanish in production — and a notification that only
 * sometimes arrives is worse than none, because it gets trusted. The customer
 * waits a few hundred milliseconds on the one tap in the whole flow where
 * they are already expecting something to happen.
 */
async function announceAccepted(token) {
  if (!notifyConfigured()) return;

  try {
    const rows = await select(
      `quotes?token=eq.${encodeURIComponent(token)}` +
        `&select=customer_name,address,service_keys,amount,lead_id,customer_id,sent_by`
    );
    const q = Array.isArray(rows) ? rows[0] : rows;
    if (!q) return;

    // Deliberately a second round trip rather than a PostgREST embed. The
    // embed needs the foreign-key constraint's name to disambiguate, and
    // guessing it wrong fails the WHOLE select — losing the notification to
    // save one request. A name is the least important field here.
    let sentByName = null;
    if (q.sent_by) {
      try {
        const people = await select(
          `profiles?id=eq.${encodeURIComponent(q.sent_by)}&select=full_name`
        );
        sentByName = (Array.isArray(people) ? people[0] : people)?.full_name || null;
      } catch {
        // Fine. "Quoted by (unknown)" is still a useful email.
      }
    }

    const { subject, html } = quoteAcceptedNotification({
      customerName: q.customer_name,
      address: q.address,
      serviceKeys: q.service_keys,
      amount: q.amount,
      sentByName,
      leadId: q.lead_id,
      customerId: q.customer_id,
    });

    const sent = await notify({ subject, html });
    if (!sent.ok) {
      console.error("[quote-accept:notify]", JSON.stringify({ reason: sent.reason }));
    }
  } catch (err) {
    console.error("Accepted, but couldn't send the notification:", err);
  }
}

// A token is 64 hex characters. Rejecting anything else before it reaches the
// database turns a scan into a cheap 404 instead of a query, and keeps
// obviously-junk input out of the logs.
const TOKEN = /^[0-9a-f]{64}$/i;

function tokenFrom(req) {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export default async (req) => {
  const token = tokenFrom(req);

  if (!TOKEN.test(token)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // ---- read ---------------------------------------------------------------
  if (req.method === "GET") {
    try {
      const rows = await rpc("sb_quote_public", { p_token: token });
      const quote = Array.isArray(rows) ? rows[0] : rows;
      if (!quote) {
        // Same shape and status as a malformed token. A customer with a real
        // link never sees this, and anyone guessing learns nothing about
        // whether a token existed and was deleted.
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json(
        { quote },
        // Never cached. A quote that has just been accepted must not keep
        // rendering its Accept button from a CDN copy.
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (err) {
      console.error("Quote lookup failed:", err);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  }

  // ---- accept -------------------------------------------------------------
  if (req.method === "POST") {
    try {
      const rows = await rpc("sb_accept_quote", { p_token: token });
      const result = Array.isArray(rows) ? rows[0] : rows;

      if (!result?.ok) {
        // 200, not an error status. "Expired" and "already declined" are
        // answers, not faults, and the page needs the reason to say something
        // useful rather than rendering a generic failure.
        return Response.json({
          ok: false,
          reason: result?.reason || "not_found",
        });
      }
      // Only on the real transition. `already` is a customer tapping Accept
      // twice, or reopening the link on a page they've already accepted from
      // — which, before this guard, would have sent a fresh "they said yes"
      // every time and made a token into a button for mailing the company.
      if (!result.already) await announceAccepted(token);

      return Response.json({
        ok: true,
        already: Boolean(result.already),
      });
    } catch (err) {
      console.error("Quote accept failed:", err);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
};

export const config = {
  path: "/api/quote/:token",
};
