// netlify/lib/leadAlerts.mjs
//
// "New lead" — to Jordan and Hayden, within a minute of the form.
//
// WHAT THIS REPLACES. The website posted to api.web3forms.com from the
// customer's browser and that POST was the only thing that told anybody a
// lead had arrived. On 12 October it did not go through — Web3Forms has no
// record of the request, which from the far end is what an ad blocker looks
// like — and the first contact went out two hours later. The lead row was in
// the database the whole time.
//
// Anything sent from the customer's browser can be stopped by the customer's
// browser. This runs on the CRM's own schedule, reading the row that is
// already committed, so the alert now depends on exactly the same thing the
// lead does.
//
// Environment:
//   ALERT_SMS_TO — comma-separated numbers, e.g. "+15415551234,+15415555678".
//                  UNSET MEANS OFF, silently and on purpose: a half-deployed
//                  CRM must not start throwing on every sweep.
//
// Everything else it needs — the Quo key, the sending number — is already
// set, because this uses the same sendSms() the acknowledgments do.

import { rpc } from "../lib/db.mjs";
import { sendSms, toE164 } from "./sms.mjs";

/**
 * Who gets told.
 *
 * Parsed on every call rather than at import. Netlify reuses a warm function
 * instance for minutes at a time, so a value read once at module load is a
 * value that keeps its old setting after somebody changes it in the
 * dashboard and wonders why nothing happened.
 *
 * Bad entries are dropped rather than failing the batch: a trailing comma,
 * or one number typed wrong, must not stop the other brother being told.
 */
export function alertNumbers(raw = process.env.ALERT_SMS_TO) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[,;\s]+/)
        .map((s) => toE164(s))
        .filter(Boolean)
    ),
  ];
}

// How a source reads in a text. The database words are for the database.
const SOURCES = {
  website: "the website",
  google_lsa: "Google Local Services",
  google_ads: "Google Ads",
  door: "a door knock",
  referral: "a referral",
  repeat: "a repeat customer",
};

const SERVICES = {
  windows: "window cleaning",
  gutters: "gutter cleaning",
  solar: "solar panel cleaning",
  pressure: "pressure washing",
};

/**
 * The text itself.
 *
 * SHAPED FOR A LOCK SCREEN, which is the only place most of these will ever
 * be read. The name and the phone number are the first thing, because the
 * decision this text exists to prompt is "ring them now", and a notification
 * that has to be opened to find the number has already lost the minute it
 * was trying to save.
 *
 * No link to the CRM. A link would be the obvious thing to add and it would
 * make this worse: tapping it opens a browser, waits for an app to load, and
 * asks for a login, when the useful action is a phone call to a number that
 * is right there in the message.
 *
 * Lines rather than one paragraph. iOS shows two lines on a locked screen
 * and the first two are the two that matter.
 */
export function alertText(lead) {
  const who = lead.out_name || "Someone";
  const from = SOURCES[lead.out_source] || lead.out_source || "the website";

  const lines = [`New lead from ${from}: ${who}`];

  // The number on its own line, undecorated, so a phone linkifies it.
  if (lead.out_phone) lines.push(lead.out_phone);
  else if (lead.out_email) lines.push(lead.out_email);

  const detail = [];
  if (lead.out_service) detail.push(SERVICES[lead.out_service] || lead.out_service);
  if (lead.out_address) detail.push(lead.out_address);
  if (detail.length) lines.push(detail.join(" · "));

  return lines.join("\n");
}

/**
 * Claim whatever is owed an alert and send it.
 *
 * NEVER THROWS. It is called from the same sweep as the acknowledgments, and
 * a failure to tell Jordan about a lead must not stop the customer being
 * told we got their message. Problems come back in the return value, where
 * the caller logs them.
 *
 * Returns { texted, skipped, problems } — texted counts MESSAGES, not leads,
 * because two numbers is two messages and a run that tells one brother and
 * fails the other is not a clean run.
 */
export async function runLeadAlerts({ limit = 10 } = {}) {
  const out = { texted: 0, skipped: 0, problems: [] };

  const to = alertNumbers();
  if (to.length === 0) {
    // NOT A PROBLEM, and deliberately not counted as one. ALERT_SMS_TO unset
    // is how this is switched off, and a sweep that logged a complaint every
    // minute about a feature nobody turned on would bury the ones that
    // matter.
    //
    // Nothing is claimed either — note the early return is BEFORE the rpc.
    // Claiming and then discovering there is nowhere to send would mark
    // every lead as alerted while the setting was missing, and they would
    // never be alerted again once it was fixed.
    return out;
  }

  let due;
  try {
    due = (await rpc("sb_claim_lead_alerts", { p_limit: limit })) || [];
  } catch (err) {
    out.problems.push({ stage: "claim", reason: String(err?.message || err) });
    return out;
  }

  for (const lead of due) {
    const body = alertText(lead);

    for (const number of to) {
      try {
        const sent = await sendSms({
          kind: "alert",
          phone: number,
          body,
          // NO leadId, and this is the line to get wrong. Passing it would
          // file an internal "new lead from the website" message onto the
          // CUSTOMER's text thread, where it would sit until the day
          // somebody scrolled back through the conversation with them.
          //
          // It also means these never count as having contacted the lead —
          // sb_due_lead_acks disqualifies a lead with any outbound text on
          // it, so an alert carrying a leadId would silently cancel the
          // customer's own acknowledgment.
          //
          // force: true. Quiet hours exist to stop the CRM texting a
          // CUSTOMER at 11pm. These two asked to be woken up.
          force: true,
        });

        if (sent?.ok) out.texted += 1;
        else {
          out.skipped += 1;
          if (sent?.reason && sent.reason !== "already_sent") {
            out.problems.push({
              lead: lead.out_lead_id,
              to: String(number).slice(-4),
              reason: sent.reason,
            });
          }
        }
      } catch (err) {
        // One bad number must not cost the other brother his text, or the
        // rest of the batch.
        out.problems.push({
          lead: lead.out_lead_id,
          to: String(number).slice(-4),
          reason: String(err?.message || err),
        });
      }
    }
  }

  return out;
}
