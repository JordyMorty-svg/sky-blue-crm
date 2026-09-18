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
//   SUPABASE_SERVICE_KEY  — service role
//
// Both handlers call SECURITY DEFINER functions (sb_quote_public,
// sb_accept_quote) rather than reading the table: the narrow, deliberately
// chosen column list lives in SQL, next to the data, where it can be
// reviewed in one place instead of trusted to every caller.

async function rpc(fn, args) {
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Supabase ${res.status}`);
  return data;
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
