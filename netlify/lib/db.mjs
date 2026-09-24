// netlify/lib/db.mjs
//
// One way for a Netlify function to call the database.
//
// This lived in followUps.mjs, because that is where it was first needed,
// and four other modules ended up importing it from there — a texting
// library importing its database access out of the follow-up email module is
// the kind of thing that is fine until it isn't.
//
// It isn't, now: netlify/lib/email.mjs records every send, and followUps.mjs
// sends email, so the two would import each other. ESM tolerates a cycle
// like that and then breaks in a way that looks like a completely unrelated
// bug, months later, when somebody moves a top-level statement.
//
// followUps.mjs re-exports rpc so every existing import of it still works.

const SUPABASE_URL = () =>
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

// Works with either generation of Supabase key.
//
// The legacy `service_role` key is a JWT, and PostgREST reads the role it
// should act as out of the Authorization header — so that one has to be sent
// twice, as apikey AND as a bearer token.
//
// The newer `sb_secret_...` keys are NOT JWTs, and Supabase's docs are
// explicit that they go on the apikey header ONLY. Sending one as a bearer
// token makes the gateway try to parse it as a JWT and reject the request,
// which would show up as a 401 on every run with a key that is perfectly
// valid.
//
// Sniffing for the JWT prefix rather than asking which kind it is: there is
// no third option, the check can't go stale, and the legacy keys are being
// retired at the end of 2026 — so this needs to keep working across a swap
// that happens in the dashboard with no deploy.
export function supabaseHeaders(key) {
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Call a security-definer function.
 *
 * Runs on a schedule with no user logged in, so it uses a key that bypasses
 * RLS. That is exactly why nothing that uses this writes to tables directly —
 * every call is one of the functions in db/*.sql, so the rules stay in one
 * place rather than being re-implemented by a caller that happens to be able
 * to ignore them.
 */
export async function rpc(fn, body = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL() || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set"
    );
  }

  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${fn}`, {
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

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Call one that we would rather not fail the caller over.
 *
 * Bookkeeping — recording that an email went out, noting a delivery verdict —
 * is not worth losing the thing it is bookkeeping about. A quote that
 * reached the customer but wasn't written down is a much smaller problem
 * than a quote that wasn't sent because writing it down failed.
 *
 * Logged loudly, though. Silence here would mean the failures list quietly
 * stops being complete and nothing ever says so.
 */
export async function rpcQuietly(fn, body = {}) {
  try {
    return await rpc(fn, body);
  } catch (err) {
    console.error(`[db] ${fn} failed:`, err?.message || err);
    return null;
  }
}
