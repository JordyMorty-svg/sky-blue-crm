// netlify/functions/poll-delivery.mjs
//
// Asking Quo what happened, every fifteen minutes.
//
// Quo publishes no failure webhook — `message.received` and
// `message.delivered`, and nothing else — so a carrier rejection is only ever
// discovered by asking. send-sms.mjs already asks once a night, and that is
// not enough for one specific message.
//
// THE DAY-BEFORE CONFIRMATION GOES OUT IN THAT SAME NIGHTLY RUN.
//
// So a reminder the carrier refuses at 4pm today would not be looked at until
// 4pm tomorrow — by which point two people have already driven to a house
// that was not expecting them, and the email fallback fires the afternoon
// after the job it was confirming. The whole feature would be a record of
// something that had already gone wrong.
//
// Fifteen minutes makes that the same afternoon, with time to email it or
// phone them.
//
// It is close to free. This asks only about texts Quo has accepted and never
// confirmed, which on a normal day is nothing at all: with `message.delivered`
// ticked in Quo, a successful send is confirmed within seconds and drops out
// of the working set before this ever wakes up. Most runs make zero API
// calls and cost one function invocation.
//
// A SHORT WINDOW on purpose. Two hours, not seven days. This is the fast
// path for something that just happened; the nightly run keeps the seven-day
// sweep, so a message missed here because Quo was briefly down is still
// caught. Two jobs, two windows, one shared implementation.

import { reconcileSms } from "../lib/smsReconcile.mjs";

export default async () => {
  const started = Date.now();

  try {
    const summary = await reconcileSms({ days: 2, limit: 50 });

    // Quiet unless there is something to say. This runs ninety-six times a
    // day and a log line every time would bury the four that matter — and
    // Netlify's function log is where "what happened to that text?" is
    // actually answered.
    if (summary.undelivered || summary.problems?.length || summary.error) {
      console.log(
        "[poll-delivery]",
        JSON.stringify({ ...summary, ms: Date.now() - started })
      );
    }

    return new Response(null, { status: 204 });
  } catch (err) {
    // Thrown, so a broken poller shows as a failed scheduled invocation in
    // the Netlify dashboard rather than as a run that quietly finds nothing
    // forever. Silence and success look identical here otherwise.
    console.error("[poll-delivery] failed", err);
    throw err;
  }
};

export const config = {
  // Every fifteen minutes, on the quarter hour.
  //
  // Not "*/15 * * * *" anchored to anything clever: the work is idempotent —
  // mark_sms_undelivered() only reports a failure once — so two runs
  // overlapping or a run firing twice costs nothing but a wasted lookup.
  schedule: "*/15 * * * *",
};
