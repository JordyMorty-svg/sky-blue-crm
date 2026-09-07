// netlify/functions/run-follow-ups.mjs
//
// The same run as the daily schedule, on demand and behind a login.
//
// Two jobs:
//   GET  /api/run-follow-ups   — preview. Who would be emailed right now?
//                                Changes nothing.
//   POST /api/run-follow-ups   — send, for real.
//
// The preview exists so "who is this about to email?" is never answered by
// running the real thing and watching what happens.

import { runFollowUps, sendFollowUpToCustomer } from "../lib/followUps.mjs";

// Same check the receipt endpoint uses: a real Supabase session, verified
// against Supabase rather than trusted from the request.
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

  const preview = req.method === "GET";

  // A POST carrying a customerId means "send to this one now" — the button
  // on the Communication page, and the way the whole thing gets tested
  // against a test customer. A POST with no body is the batch run.
  //
  // Body parsed leniently: a plain POST from the batch button sends nothing
  // at all, and that must not read as a malformed request.
  let customerId = null;
  if (!preview) {
    try {
      const body = await req.json();
      customerId = body?.customerId || null;
    } catch {
      customerId = null;
    }
  }

  // A manual send ignores FOLLOW_UPS_MODE — a person pressed the button, so
  // "off" isn't the answer. The database rules still apply in full, which
  // is the point of keeping them there: neither shortcut can email someone
  // who has unsubscribed.
  try {
    const summary = customerId
      ? await sendFollowUpToCustomer(customerId, { siteUrl: process.env.URL })
      : await runFollowUps({
          mode: preview ? "preview" : "send",
          siteUrl: process.env.URL,
        });

    // `summary.mode` is what THIS run did, which is always preview or send —
    // a person pressed a button. `configured_mode` is what the daily
    // schedule will do tomorrow, and they are different questions. Without
    // this the CRM could show a healthy preview while the automation behind
    // it is switched off, and nothing on screen would say so.
    const body = {
      ...summary,
      configured_mode: process.env.FOLLOW_UPS_MODE || "off",
    };

    console.log("[follow-ups:manual]", JSON.stringify(body));
    return Response.json(body);
  } catch (err) {
    console.error("[follow-ups:manual] failed", err);
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
};

export const config = {
  path: "/api/run-follow-ups",
};
