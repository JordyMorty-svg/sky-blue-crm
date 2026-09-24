// netlify/functions/check-delivery.mjs
//
// "Check Quo" — the button on the Undelivered page.
//
//   POST /api/check-delivery   asks Quo about every text it accepted in the
//                              last 7 days but never confirmed, and records
//                              the real verdict.
//
// Behind a login, because it is a person pressing a button. The nightly pass
// runs the same code from send-sms.mjs, so the button genuinely exercises the
// schedule rather than a lookalike — the same arrangement as run-sms.mjs.
//
// This is the endpoint that fixes history. Quo has no failure webhook, so
// until now nothing was ever going to tell the CRM that a quote to a
// landline had been refused. Pressing this once brings every send of the
// last week up to date, including the ones that failed before this code
// existed.

import { reconcileSms } from "../lib/smsReconcile.mjs";

// Same check the other manual endpoints use: a real Supabase session,
// verified against Supabase rather than trusted from the request.
async function verifyUser(req) {
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return false;
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  return res.ok;
}

export default async (req) => {
  if (!(await verifyUser(req))) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // How far back to look. Capped at 30 days: Quo's answer stops changing
  // long before then, and an unbounded window turns one button press into
  // thousands of API calls.
  let days = 7;
  try {
    const body = await req.json();
    const asked = Number(body?.days);
    if (Number.isFinite(asked) && asked > 0) days = Math.min(asked, 30);
  } catch {
    // No body is the normal case.
  }

  try {
    const summary = await reconcileSms({ days, limit: 200 });
    console.log("[check-delivery]", JSON.stringify(summary));
    return Response.json(summary);
  } catch (err) {
    console.error("[check-delivery] failed", err);
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
};

export const config = {
  path: "/api/check-delivery",
};
