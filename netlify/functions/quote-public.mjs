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

/**
 * Is this request coming from a signed-in member of staff?
 *
 * Returns "staff", "public", or "unknown" — and the third one is the whole
 * reason this isn't a boolean.
 *
 * What hangs on it: a staff request must not mark the quote as read by the
 * customer, and must not be allowed to accept on their behalf. A public
 * request must do the first and may do the second.
 *
 * The three cases are NOT interchangeable:
 *
 *   * "staff"   — a token that Supabase Auth confirmed belongs to a user.
 *   * "public"  — no token at all, or a token Supabase actively REJECTED.
 *                 That is a real answer: we asked, and they are not staff.
 *   * "unknown" — we could not ask. The anon key is missing, Supabase is
 *                 down, the fetch threw. We have no idea who this is.
 *
 * "unknown" is treated as staff for MARKING (don't record a view we cannot
 * attribute) and as staff for ACCEPTING (don't book a job on a request we
 * cannot identify). Both failure directions are recoverable by a human; the
 * opposite ones silently corrupt a follow-up or create a commission.
 *
 * Note what this does NOT do: it never trusts a flag from the browser. An
 * earlier sketch had the page send `?preview=1`, which any customer could
 * append to skip being recorded. The bearer token is the only claim here
 * that cannot be made up, because making one up requires logging in.
 */
async function identify(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "").trim();
  if (!token) return "public";

  const url = process.env.VITE_SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error("identify(): VITE_SUPABASE_ANON_KEY missing — cannot verify callers");
    return "unknown";
  }

  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    // 401/403 is Supabase telling us this is not a valid session. That is an
    // answer, not a failure — an expired tab belongs to the public.
    if (res.status === 401 || res.status === 403) return "public";
    if (!res.ok) return "unknown";
    const user = await res.json().catch(() => null);
    return user?.id ? "staff" : "public";
  } catch (err) {
    console.error("identify() couldn't reach Supabase Auth:", err);
    return "unknown";
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

  // Asked once, used by both handlers. A signed-in member of staff looking at
  // a quote is a PREVIEW: it must not record the customer as having read it,
  // and it must not be able to accept on their behalf.
  const who = await identify(req);
  const preview = who !== "public";

  // ---- read ---------------------------------------------------------------
  if (req.method === "GET") {
    try {
      const rows = await rpc("sb_quote_public", {
        p_token: token,
        // The only request that marks a quote as read is one we positively
        // identified as coming from outside the company.
        p_mark: !preview,
      });
      const quote = Array.isArray(rows) ? rows[0] : rows;
      if (!quote) {
        // Same shape and status as a malformed token. A customer with a real
        // link never sees this, and anyone guessing learns nothing about
        // whether a token existed and was deleted.
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json(
        // `preview` drives the banner on the page. Sent so the person looking
        // knows the state they are seeing is untouched — without it, a rep
        // checking a quote has no way to tell whether looking cost them the
        // "not opened yet" signal, and the safe assumption is the wrong one.
        { quote, preview },
        // Never cached. A quote that has just been accepted must not keep
        // rendering its Accept button from a CDN copy. Doubly so now: a
        // preview response and a customer's response differ, and a CDN
        // serving one for the other would be the bug this file just fixed.
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (err) {
      console.error("Quote lookup failed:", err);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  }

  // ---- accept -------------------------------------------------------------
  if (req.method === "POST") {
    // Staff cannot accept for the customer. A quote page opened as a preview
    // still renders an Accept button's worth of screen, and a mis-tap would
    // book a job, move the lead, set its estimate and credit a booking
    // commission — a chain that is tedious to unwind and leaves lead_events
    // carrying an acceptance that never happened.
    //
    // Refused BEFORE sb_accept_quote, not after: that function is where the
    // booking happens, so the only safe place to stop is in front of it.
    //
    // 200 with a reason, like every other outcome here. The page explains it.
    if (preview) {
      return Response.json({ ok: false, reason: "staff_preview" });
    }

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
