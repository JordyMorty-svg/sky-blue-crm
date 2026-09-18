// netlify/functions/run-sms.mjs
//
// The same run as the daily schedule, on demand and behind a login.
//
//   GET  /api/run-sms  — preview. Who would be texted right now, and the
//                        exact words. Changes nothing.
//   POST /api/run-sms  — send, for real.
//
// The preview is the whole reason this endpoint exists. Texting is the one
// thing in this CRM that cannot be undone, cannot be recalled, and costs
// money per attempt — so "who is this about to message?" must be answerable
// without finding out.

import { runSms, previewSms } from "../lib/smsRun.mjs";
import { smsMode, smsConfigured } from "../lib/sms.mjs";

// Same check the receipt and follow-up endpoints use: a real Supabase
// session, verified against Supabase rather than trusted from the request.
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

  try {
    // A preview goes through previewSms() directly rather than through
    // runSms({mode:"preview"}), so that it still shows you the queue when
    // SMS_MODE is "off" — which is exactly when you most want to look.
    const summary = preview
      ? { mode: "preview", would_send: await previewSms({}) }
      : await runSms({ mode: "send" });

    // `mode` is what THIS run did; `configured_mode` is what the daily
    // schedule will do tomorrow. Different questions — without the split,
    // the CRM could show a healthy preview while the automation behind it is
    // switched off and nothing on screen would say so.
    const body = {
      ...summary,
      configured_mode: smsMode(),
      configured: smsConfigured(),
    };

    console.log("[sms:manual]", JSON.stringify(body));
    return Response.json(body);
  } catch (err) {
    console.error("[sms:manual] failed", err);
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
};

export const config = {
  path: "/api/run-sms",
};
