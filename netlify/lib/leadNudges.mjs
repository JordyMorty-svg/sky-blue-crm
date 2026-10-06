// netlify/lib/leadNudges.mjs
//
// The text that follows a lead moving to contacted, quoted or booked.
//
// Lives outside netlify/functions/ because everything in that folder deploys
// as its own endpoint, and this is shared code: ack-leads.mjs runs it on the
// same per-minute sweep that sends website acknowledgments.
//
// THIS FILE HOLDS NO POLICY. Which leads are due, which message they get,
// whether a quote already went out, whether somebody was texted an hour ago —
// all of that is decided by sms_due_lead_nudges() in db/lead-nudges.sql, and
// deliberately so. The rules have to be re-checked at SEND time against the
// state as it is then, and a copy of them here would be a second answer to
// the same question, which is the thing that goes wrong.
//
// What this file does: turn the rows that function returns into words, hand
// them to sendSms, and count what happened.

import { rpc } from "./db.mjs";
import {
  sendSms,
  nudgeContactedSms,
  nudgeQuotedSms,
  nudgeBookedSms,
} from "./sms.mjs";

/**
 * The message for one due row, or null if it cannot be written.
 *
 * Exported so verify/lead-nudges.mjs can check the wording against the row
 * shape the database actually returns, without a database.
 */
export function nudgeBody(row) {
  const customerName = row.out_name;
  const sentByName = row.out_sender || null;

  switch (row.out_kind) {
    case "nudge_contacted":
      return nudgeContactedSms({ customerName, service: row.out_service, sentByName });

    case "nudge_quoted":
      // No price, no message. The whole content of this one is the number;
      // "we've got you down at $0" would be worse than staying quiet, and a
      // lead moved to quoted before anyone typed an estimate is an ordinary
      // thing that happens mid-call.
      if (!(Number(row.out_estimate) > 0)) return null;
      return nudgeQuotedSms({
        customerName,
        amount: row.out_estimate,
        service: row.out_service,
        sentByName,
      });

    case "nudge_booked":
      // nudgeBookedSms returns null without a time. The database already
      // refuses to return a booked row with no appointment, so this is the
      // second of two locks on the same door — cheap, and the one that holds
      // if the query is ever loosened.
      return nudgeBookedSms({ customerName, startsAt: row.out_appoint_at, sentByName });

    default:
      // A kind this build does not know about. Silence is right: an unknown
      // kind means the database is ahead of the deploy, and guessing at the
      // wording of a message somebody else wrote is worse than waiting for
      // the deploy to catch up.
      return null;
  }
}

/**
 * One pass. Never throws.
 *
 * The caller is a scheduled function that also sends website
 * acknowledgments; a nudge blowing up must not take those down with it, and
 * one bad row must not abandon the rest of the batch.
 */
export async function runLeadNudges({ limit = 25 } = {}) {
  let texted = 0;
  let skipped = 0;
  const problems = [];

  let due = [];
  try {
    due = (await rpc("sms_due_lead_nudges", { p_limit: limit })) || [];
  } catch (err) {
    // Most likely db/lead-nudges.sql has not been run yet. Reported, not
    // thrown: the acknowledgment sweep in the same invocation still works.
    return { texted: 0, skipped: 0, problems: [{ reason: String(err?.message || err) }] };
  }

  for (const row of due) {
    try {
      const body = nudgeBody(row);
      if (!body) {
        skipped += 1;
        continue;
      }

      // sendSms() does the claim ITSELF.
      //
      // Worth restating here because the first draft of ack-leads.mjs called
      // claim_sms and then sendSms, which claims again — the second claim hit
      // the dedupe index, came back already-claimed, and nothing was ever
      // sent. A feature that silently does nothing, built out of two
      // functions that both work.
      //
      // NOT forced past quiet hours, and this is the opposite call from the
      // acknowledgment next door. That one answers somebody who typed their
      // number into a form sixty seconds ago and is still at their laptop.
      // This one is us starting a conversation fifteen minutes after we moved
      // a card on a board the customer cannot see. At 8:15pm that can wait
      // until nine.
      const sent = await sendSms({
        kind: row.out_kind,
        phone: row.out_phone,
        body,
        leadId: row.out_lead_id,
      });

      if (sent?.ok) {
        texted += 1;
      } else if (sent?.reason === "already_sent" || sent?.reason === "already_claimed") {
        // Two runs racing, or the overlap guard doing its job. Not a fault.
        skipped += 1;
      } else {
        skipped += 1;
        problems.push({ lead: row.out_lead_id, kind: row.out_kind, reason: sent?.reason || "not sent" });
      }
    } catch (err) {
      problems.push({
        lead: row.out_lead_id,
        kind: row.out_kind,
        reason: String(err?.message || err),
      });
    }
  }

  return { texted, skipped, problems };
}
