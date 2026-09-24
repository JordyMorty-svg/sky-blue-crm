// netlify/functions/send-sms.mjs
//
// The daily run. Netlify calls this on a schedule; nothing else does.
//
// It holds no logic of its own — everything is in netlify/lib/smsRun.mjs,
// shared with the manual preview endpoint, so what the CRM shows you is
// produced by the same code that does the sending.
//
// Turning it on is SMS_MODE=send in the Netlify environment. Until then this
// wakes up, does nothing, and says so in the log. Deploying the code does not
// start texting anybody — and until US carrier registration is approved in
// Quo, the number could not legitimately send anyway.

import { runSms } from "../lib/smsRun.mjs";
import { reconcileSms } from "../lib/smsReconcile.mjs";

export default async () => {
  const started = Date.now();

  try {
    /*
     * Ask Quo what happened to yesterday's texts BEFORE sending today's.
     *
     * The order is not arbitrary. Quo has no failure webhook, so a carrier
     * rejection is only ever discovered by asking — and until it has been
     * asked about, a refused quote still occupies its slot in the
     * double-send index as an ordinary 'sent' row. Reconciling first means
     * tonight's nudge run sees the true state of last night's sends, and a
     * number the carrier has closed is out of the way before anything else
     * is aimed at it.
     *
     * Never fails the run. The sending is the job; catching up on verdicts
     * is bookkeeping, and bookkeeping that takes the night's texts down with
     * it would be a much worse trade.
     */
    let verdicts = null;
    try {
      verdicts = await reconcileSms({ days: 7, limit: 200 });
    } catch (err) {
      console.error("[sms] could not reconcile with Quo", err);
      verdicts = { error: String(err?.message || err) };
    }

    const summary = await runSms();

    // One JSON object rather than several lines: Netlify keeps function
    // logs, and this is the audit trail for "did we text anyone on the
    // 14th?" It names every number touched and why each one was skipped.
    console.log(
      "[sms]",
      JSON.stringify({ ...summary, verdicts, ms: Date.now() - started })
    );

    return new Response(null, { status: 204 });
  } catch (err) {
    // A throw shows up as a failed scheduled invocation in the Netlify
    // dashboard, which is the visible signal that something needs looking
    // at. Swallowing it would make a broken automation look healthy.
    console.error("[sms] run failed", err);
    throw err;
  }
};

export const config = {
  // 23:00 UTC — 4pm Pacific in summer, 3pm in winter. Cron is always UTC and
  // Netlify has no timezone option, so this drifts an hour across daylight
  // saving; sb_sms_quiet_now() is what actually guarantees nothing goes out
  // at an unreasonable hour, precisely because this line cannot.
  //
  // Mid-afternoon on purpose. It is the day-before reminder that sets the
  // time: late enough that somebody is home from work to read it, early
  // enough that they can still ring and move the job if tomorrow no longer
  // suits. The quote nudges are indifferent and come along for the ride.
  schedule: "0 23 * * *",
};
