// netlify/lib/smsRun.mjs
//
// One pass of the automatic texts: quote nudges and day-before reminders.
//
// Shared by send-sms.mjs (the daily schedule) and run-sms.mjs (the manual
// "what would go out?" button), so the button genuinely exercises the
// schedule rather than a lookalike. Same arrangement as followUps.mjs.

import { rpc } from "./followUps.mjs";
import {
  sendSms,
  smsMode,
  smsConfigured,
  nudgeOpenedSms,
  nudgeUnopenedSms,
  reminderSms,
  segmentsFor,
} from "./sms.mjs";

/**
 * What each due row should actually say.
 *
 * Separated from the sending so that preview and send build the text through
 * exactly the same code. A preview that composes its own approximation of
 * the message is a preview of nothing.
 */
function composeNudge(row) {
  const args = {
    customerName: row.customer_name,
    amount: row.amount,
    token: row.token,
    // Whoever sent the original quote, carried through by
    // sms_due_quote_nudges. A chase-up signed by the other brother reads as
    // a different person picking the thread up, which is not what happened.
    // Null when the quote's sender has left profiles; the template then
    // signs as the company rather than guessing.
    sentByName: row.sender_name,
  };
  return row.kind === "nudge_viewed" ? nudgeOpenedSms(args) : nudgeUnopenedSms(args);
}

function composeReminder(row) {
  return reminderSms({
    customerName: row.customer_name,
    startsAt: row.starts_at,
  });
}

/**
 * Everything that would go out right now, with the exact words.
 *
 * Claims nothing, writes nothing. This is what the CRM shows before anyone
 * turns the automation on — "who is this about to text?" should never be
 * answered by running the real thing and watching what happens.
 */
export async function previewSms({ limit = 25 } = {}) {
  const [nudges, reminders] = await Promise.all([
    rpc("sms_due_quote_nudges", { p_limit: limit }),
    rpc("sms_due_job_reminders", { p_limit: limit }),
  ]);

  const describe = (row, body) => ({
    to: row.phone,
    name: row.customer_name,
    kind: row.kind || "reminder",
    body,
    // Shown because it is the cost. Three segments to chase a $250 quote is
    // still obviously worth it, but it should be visible rather than
    // discovered on a bill.
    segments: segmentsFor(body).segments,
    encoding: segmentsFor(body).encoding,
  });

  return [
    ...(nudges || []).map((r) => describe(r, composeNudge(r))),
    ...(reminders || []).map((r) => describe(r, composeReminder(r))),
  ];
}

/**
 * One real pass.
 *
 * mode:
 *   "off"     — do nothing at all. THE DEFAULT. Deploying this code must not
 *               start texting customers, and until US carrier registration
 *               is approved the number cannot legitimately send anyway.
 *   "preview" — work out exactly who would be texted and what it would say,
 *               touching nothing.
 *   "send"    — for real.
 */
export async function runSms({ mode, limit = 25 } = {}) {
  const chosen = mode || smsMode();

  if (chosen === "off") {
    return { mode: chosen, sent: 0, skipped: 0, note: "SMS_MODE is off" };
  }

  if (chosen === "preview") {
    return { mode: chosen, sent: 0, skipped: 0, would_send: await previewSms({ limit }) };
  }

  if (!smsConfigured()) {
    // Named loudly rather than failing one message at a time. A run that
    // reports 25 individual failures for one missing environment variable
    // buries the actual problem.
    return { mode: chosen, sent: 0, skipped: 0, error: "Quo credentials are not set" };
  }

  // Release anything a previous run claimed and died holding, BEFORE
  // claiming anything new — otherwise those quotes stay unchaseable.
  const swept = await rpc("sweep_sms");

  const [nudges, reminders] = await Promise.all([
    rpc("sms_due_quote_nudges", { p_limit: limit }),
    rpc("sms_due_job_reminders", { p_limit: limit }),
  ]);

  const work = [
    ...(nudges || []).map((row) => ({
      row,
      body: composeNudge(row),
      args: {
        kind: row.kind,
        quoteId: row.quote_id,
        leadId: row.lead_id,
        customerId: row.customer_id,
      },
    })),
    ...(reminders || []).map((row) => ({
      row,
      body: composeReminder(row),
      args: {
        kind: "reminder",
        jobId: row.job_id,
        leadId: row.lead_id,
        customerId: row.customer_id,
      },
    })),
  ];

  let sent = 0;
  let skipped = 0;
  const results = [];

  // Serial, not Promise.all. Quo allows ten requests a second and the volume
  // here is a handful a day, so there is nothing to gain from parallelism and
  // a rate-limit rejection to lose.
  //
  // force is NOT set. This is the automation: if it wakes up outside sending
  // hours — a retry, a schedule nudged by daylight saving — the right answer
  // is to text nobody and pick them up tomorrow, not to ring a phone at 6am.
  for (const item of work) {
    const result = await sendSms({
      ...item.args,
      phone: item.row.phone,
      body: item.body,
    });

    if (result.ok) sent += 1;
    else skipped += 1;

    results.push({
      to: item.row.phone,
      name: item.row.customer_name,
      kind: item.args.kind,
      ok: result.ok,
      reason: result.ok ? null : result.reason,
    });
  }

  return { mode: chosen, swept, due: work.length, sent, skipped, results };
}
