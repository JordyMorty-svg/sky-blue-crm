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
//                  UNSET MEANS NO TEXTS, silently and on purpose: a
//                  half-deployed CRM must not start throwing on every sweep.
//   NOTIFY_TO    — the company inbox, already set, already used by the quote
//                  and acceptance notifications. Unset means no email.
//
// TWO CHANNELS, DIFFERENT JOBS, and they are not the same words twice:
//
//   the TEXT is the interruption — who, their number, one tap to call
//   the EMAIL is the record — everything they typed, filed in the inbox
//                             beside the quote confirmations
//
// INDEPENDENT, in both directions. The text sends when the inbox is not
// configured; the email sends when no numbers are. Either failing leaves the
// other alone — one notification arriving is the thing that matters, and a
// design where a bad phone number costs the email would be the same mistake
// Web3Forms made in reverse.
//
// Everything else they need — the Quo key, the sending number, the Resend
// key — is already set, because these use the same sendSms() and notify()
// the acknowledgments and quote emails do.

import { rpc } from "../lib/db.mjs";
import { sendSms, toE164 } from "./sms.mjs";
import { newLeadNotification, notify, notifyConfigured } from "./notify.mjs";

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
 * Returns { texted, emailed, skipped, problems }. `texted` counts MESSAGES,
 * not leads, because two numbers is two messages and a run that tells one
 * brother and fails the other is not a clean run.
 */
export async function runLeadAlerts({ limit = 10 } = {}) {
  const out = { texted: 0, emailed: 0, skipped: 0, problems: [] };

  const to = alertNumbers();
  const mailing = notifyConfigured();

  if (to.length === 0 && !mailing) {
    // NOT A PROBLEM, and deliberately not counted as one. Unset is how this
    // is switched off, and a sweep that logged a complaint every minute
    // about a feature nobody turned on would bury the ones that matter.
    //
    // Nothing is claimed either — note the early return is BEFORE the rpc.
    // Claiming and then discovering there is nowhere to send would mark
    // every lead as alerted while the settings were missing, and they would
    // never be alerted again once they were fixed.
    //
    // BOTH have to be missing. Numbers but no inbox, or an inbox but no
    // numbers, is a working setup with one channel — checking only one of
    // them is how turning on the email alone would silently claim and
    // discard every lead.
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

    // THE EMAIL FIRST, and it is not arbitrary. Texting is the slower of the
    // two — a Quo API call per number — so a run that is about to hit the
    // function timeout has already done the cheap thing. The email is also
    // the one that is reconstructible: a text nobody received is gone, while
    // an inbox can be searched later for what the enquiry said.
    if (mailing) {
      try {
        const { subject, html } = newLeadNotification({
          name: lead.out_name,
          phone: lead.out_phone,
          email: lead.out_email,
          address: lead.out_address,
          service: lead.out_service,
          source: lead.out_source,
          propertyType: lead.out_property_type,
          stories: lead.out_stories,
          windows: lead.out_windows,
          estimate: lead.out_estimate,
          notes: lead.out_notes,
          leadId: lead.out_lead_id,
        });

        // notify() resolves with { ok, reason } and never rejects — see its
        // header. The try/catch is for building the body, not for sending.
        const mailed = await notify({ subject, html });
        if (mailed?.ok) out.emailed += 1;
        else {
          out.skipped += 1;
          if (mailed?.reason) {
            out.problems.push({ lead: lead.out_lead_id, to: "inbox", reason: mailed.reason });
          }
        }
      } catch (err) {
        out.problems.push({
          lead: lead.out_lead_id,
          to: "inbox",
          reason: String(err?.message || err),
        });
      }
    }

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
