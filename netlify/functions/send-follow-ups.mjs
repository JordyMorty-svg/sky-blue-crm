// netlify/functions/send-follow-ups.mjs
//
// The daily run. Netlify calls this on a schedule; nothing else does.
//
// It holds no logic of its own — everything is in netlify/lib/followUps.mjs,
// shared with the manual "send now" endpoint, so pressing that button
// exercises the same code path this does rather than a lookalike.
//
// Turning it on is FOLLOW_UPS_MODE=send in the Netlify environment.
// Until then this wakes up, does nothing, and says so in the log. Deploying
// the code does not start emailing anybody.

import { runFollowUps } from "../lib/followUps.mjs";

export default async (req) => {
  const started = Date.now();

  try {
    const summary = await runFollowUps({ siteUrl: process.env.URL });

    // Netlify keeps function logs, and this line is the audit trail for
    // "did anything go out on the 14th?" — so it's one JSON object rather
    // than several lines, and it names every address touched.
    console.log("[follow-ups]", JSON.stringify({ ...summary, ms: Date.now() - started }));

    return new Response(null, { status: 204 });
  } catch (err) {
    // A throw here shows up as a failed scheduled invocation in the Netlify
    // dashboard, which is the visible signal that something needs looking
    // at — swallowing it would make a broken automation look healthy.
    console.error("[follow-ups] run failed", err);
    throw err;
  }
};

export const config = {
  // 17:00 UTC — 10am Pacific in summer, 9am in winter. Cron is always UTC,
  // and Netlify has no timezone option, so this drifts by an hour across
  // daylight saving. Fine for an email that only promises "about three
  // days"; it would not be fine for anything the customer is expecting at
  // a particular time.
  //
  // Mid-morning on purpose: the queue is built from midnight-local due
  // dates, so a job completed Monday goes out Thursday morning rather than
  // Thursday at whatever hour the crew happened to finish.
  schedule: "0 17 * * *",
};
