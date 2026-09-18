// netlify/lib/sms.mjs
//
// Sending a text, and the words that go in one.
//
// Lives outside netlify/functions/ because everything in that folder is
// deployed as its own endpoint and this is shared code. Four functions
// import it: send-quote (the quote itself), run-sms (the nightly chase),
// sms-run (the manual "what would go out?" button) and sms-inbound.
//
// WHY QUO AND NOT GOOGLE VOICE. Google Voice has no API, on any plan, and
// has never had one. Driving its web interface with a script violates the
// Google Voice Acceptable Use Policy and the Workspace Service-Specific
// Terms — and the account that would be suspended for it is the same one
// holding company@skybluecleaningco.com and the whole Workspace.
//
// Quo (formerly OpenPhone) replaces Google Voice rather than sitting beside
// it: Jordan and Hayden both get the app, replies land in a shared inbox
// they can see on their phones, and the same number is reachable from here
// over an API. One number for the business, automated and by hand.
//
// Required Netlify environment variables (server-only, no VITE_ prefix):
//   SUPABASE_SERVICE_ROLE_KEY  — same one the follow-up emails use. NOTE the
//                                spelling: send-quote.mjs also accepts
//                                SUPABASE_SERVICE_KEY, but everything under
//                                netlify/lib wants the _ROLE_ form, so that
//                                is the one that must be set.
//   QUO_API_KEY                — Quo → Settings → API. Mark it secret.
//   QUO_FROM                   — the business number, +1XXXXXXXXXX
//   SMS_MODE                   — off | preview | send  (defaults to "off")
//
// Optional:
//   QUO_USER_ID  — which Quo user an automated message is attributed to.
//                  Without it Quo attributes to the API key's owner, which
//                  is fine; with it, a nudge shows up in the shared inbox as
//                  having come from the right person.
//   QUO_API_BASE — defaults to https://api.quo.com/v1. Overridable because
//                  the company renamed from OpenPhone and the older
//                  api.openphone.com host still answers.
//   SMS_FORWARD_TO — a second number to copy inbound replies to. Usually
//                  unnecessary: the Quo app IS the inbox and pushes the
//                  reply to both phones already. Left in for the case where
//                  somebody wants them mirrored somewhere else.

// One implementation of the Supabase key handling rather than a second copy
// here. That function encodes a rule that is easy to get wrong and expensive
// to get wrong quietly: legacy `service_role` keys are JWTs and must ALSO go
// in the Authorization header, the newer `sb_secret_…` keys are not and must
// NOT. See the comment on supabaseHeaders() in followUps.mjs.
import { rpc } from "./followUps.mjs";

export const SITE =
  (process.env.URL || "https://crm.skybluecleaningco.com").replace(/\/$/, "");

// --- what mode we are in ----------------------------------------------------

/**
 * off     — send nothing at all. THE DEFAULT, deliberately. Deploying this
 *           code must not start texting customers, and in this case it
 *           cannot anyway: A2P 10DLC registration takes days to approve, so
 *           there is a window where the code is live and the number is not
 *           allowed to send. "off" is the honest state during it.
 * preview — work out exactly who would be texted and what it would say.
 *           Claims nothing, so flipping to "send" afterwards still sends.
 * send    — for real.
 *
 * Unlike FOLLOW_UPS_MODE, this is consulted on EVERY path including a person
 * pressing a button. An email sent early is a small mistake; a text sent
 * from an unregistered number is filtered by the carrier, billed anyway, and
 * counts against the number's reputation.
 */
export function smsMode() {
  const m = (process.env.SMS_MODE || "off").toLowerCase();
  return ["off", "preview", "send"].includes(m) ? m : "off";
}

export function smsConfigured() {
  return Boolean(process.env.QUO_API_KEY && process.env.QUO_FROM);
}

export const QUO_BASE = () =>
  (process.env.QUO_API_BASE || "https://api.quo.com/v1").replace(/\/$/, "");

// --- the words --------------------------------------------------------------

/**
 * Fold the characters a Mac or an iPhone inserts on your behalf back into
 * ones a phone network can carry in seven bits.
 *
 * This is not cosmetic. A message is billed and delivered in segments of 160
 * GSM-7 characters — but ONE character outside that alphabet switches the
 * whole message to UCS-2, where a segment is 70 characters. A single curly
 * apostrophe in "Here's your quote" therefore more than doubles the number
 * of segments, the cost, and the number of separate notifications the
 * customer's phone may show.
 *
 * The em dash is the one that bites, because it is what everything types
 * automatically and what reads best in the messages above.
 *
 * Written as \u escapes rather than as the characters themselves. A function
 * whose entire job is removing characters that do not survive transit should
 * not itself depend on this file's encoding surviving transit — and the row
 * of space variants, typed literally, is three invisible glyphs that look
 * exactly like one ordinary space.
 */
export function gsmSafe(s) {
  return String(s ?? "")
    .replace(/[\u2014\u2013\u2212]/g, "-")   // em dash, en dash, minus
    .replace(/[\u2018\u2019\u201B]/g, "'")  // curly single quotes
    .replace(/[\u201C\u201D]/g, '"')         // curly double quotes
    .replace(/\u2026/g, "...")                // ellipsis
    .replace(/[\u00A0\u202F\u2009]/g, " ")   // non-breaking, narrow, thin
    .replace(/\u2022/g, "*");                 // bullet
}


// The GSM-7 alphabet, for working out how a message will actually be billed.
// The extension characters (^{}[]~|\ and €) each take TWO septets, which is
// why they are counted separately rather than just being "in the set".
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

export function segmentsFor(text) {
  const s = String(text ?? "");
  let septets = 0;
  let gsm = true;

  for (const ch of s) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (!gsm) {
    // UCS-2. Counted in code UNITS, not code points — an emoji is a
    // surrogate pair and costs two.
    const units = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
    return { encoding: "UCS-2", length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
  }

  return {
    encoding: "GSM-7",
    length: septets,
    segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}

function firstName(full) {
  return String(full || "").trim().split(/\s+/)[0] || "there";
}

// Whole dollars. "$475" is a price; "$475.00" is an invoice, and this is a
// text message.
function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

export function quoteLink(token) {
  return `${SITE}/q/${token}`;
}

// Carriers require a way out of an automated message stream, and the
// customer's handset needs to have seen the word at least once for STOP to
// feel like an option rather than a gamble. Appended to everything automatic,
// never to a reply typed by a person — nobody signs a text to a neighbour
// with unsubscribe instructions.
const OPT_OUT = " Reply STOP to opt out.";

export function quoteSms({ customerName, amount, token }) {
  return gsmSafe(
    `Hey ${firstName(customerName)}, it's Jordan with Sky Blue Cleaning. ` +
      `Here's your quote for ${money(amount)} - screens and sills included. ` +
      `Accept it here: ${quoteLink(token)}` +
      OPT_OUT
  );
}

// Never opened. Assume it got buried rather than that they said no.
export function nudgeUnopenedSms({ customerName, amount, token }) {
  return gsmSafe(
    `Hi ${firstName(customerName)}, Jordan at Sky Blue Cleaning - just making ` +
      `sure this reached you. Your quote for ${money(amount)}: ${quoteLink(token)}` +
      OPT_OUT
  );
}

// They looked. Different message, because "did you get it" is plainly wrong
// when we know they opened it, and sounds like we aren't paying attention.
export function nudgeOpenedSms({ customerName, amount, token }) {
  return gsmSafe(
    `Hi ${firstName(customerName)}, Jordan at Sky Blue Cleaning. Any questions ` +
      `on the ${money(amount)} quote? Happy to adjust it. ${quoteLink(token)}` +
      OPT_OUT
  );
}

export function reminderSms({ customerName, startsAt }) {
  const when = new Date(startsAt).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });
  return gsmSafe(
    `Hi ${firstName(customerName)}, Sky Blue Cleaning here - we're scheduled ` +
      `for tomorrow at ${when}. Please leave gates unlocked and cars clear if ` +
      `you can. Reply here if you need to move it.` +
      OPT_OUT
  );
}

// --- sending ----------------------------------------------------------------

export async function postToQuo(to, body) {
  // Normalised, not trusted. Quo requires E.164 — a leading + and the country
  // code — and QUO_FROM is typed into a Netlify form by a person reading a
  // phone number off a screen, where "15412503361" looks completely correct.
  // Without the +, every send is rejected by the API while the "Text the
  // link" button in the CRM keeps working perfectly, because that one is the
  // phone's own Messages app and never touches Quo. A confusing way to lose
  // an afternoon, and one character to prevent.
  const from = toE164(process.env.QUO_FROM);
  if (!from) {
    throw new Error(
      `QUO_FROM is not a usable number (${process.env.QUO_FROM || "unset"}) - it must be E.164, e.g. +15417303593`
    );
  }

  const payload = {
    content: body,
    from,
    // An array: Quo accepts up to ten recipients per call. Always sent as a
    // single-element one, because a text to two people is a group thread and
    // every message this CRM sends is to one household.
    to: [to],
  };

  if (process.env.QUO_USER_ID) payload.userId = process.env.QUO_USER_ID;

  const res = await fetch(`${QUO_BASE()}/messages`, {
    method: "POST",
    headers: {
      // The API key goes in bare. NOT "Bearer " — Quo's docs are explicit
      // about this, and prefixing it fails with a 401 that looks exactly
      // like a wrong key.
      Authorization: process.env.QUO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 429 is its own case. Quo allows ten requests a second and the nightly
    // run is serial, so hitting it means something else is also sending —
    // worth naming rather than burying in a generic failure.
    if (res.status === 429) throw new Error("Quo rate limit (429) - try again shortly");

    const detail =
      data?.message ||
      data?.errors?.[0]?.message ||
      data?.error ||
      `HTTP ${res.status}`;
    throw new Error(`Quo: ${detail}`);
  }

  return data?.data?.id || data?.id || null;
}

/**
 * Claim, send, record. The only way a text leaves this system.
 *
 * Resolves rather than throwing, always: callers are either a scheduled run
 * working through a list, where one bad number must not abandon the batch,
 * or a page where the text is the second-best outcome and the quote link is
 * already on screen.
 *
 * Returns { ok, reason, id, sid }. The reasons are the ones claim_sms()
 * returns — opted_out, quiet_hours, already_sent, bad_number, empty_body —
 * plus sms_off, not_configured and the provider's own error text.
 */
export async function sendSms({
  kind = "manual",
  phone,
  body,
  leadId = null,
  customerId = null,
  quoteId = null,
  jobId = null,
  sentBy = null,
  // A person pressed a button. Skips quiet hours; does NOT skip an opt-out,
  // and there is no argument anywhere in this codebase that it should.
  force = false,
  mode = null,
} = {}) {
  const chosen = mode || smsMode();

  if (chosen === "off") {
    return { ok: false, reason: "sms_off" };
  }

  if (chosen === "preview") {
    // Nothing is claimed, so the dedupe slot stays free and flipping to
    // "send" afterwards still sends this exact message.
    return { ok: false, reason: "preview", preview: { to: phone, body } };
  }

  if (!smsConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  // Wrapped, and it was not always. rpc() THROWS on a database error — a
  // missing function most of all, which is what "db/sms.sql has not been run
  // yet" looks like. Unwrapped, that exception escaped sendSms, escaped
  // textTheQuote, and turned the whole /api/send-quote request into a 500:
  // the quote would not save, the link would not come back, and the failure
  // to send a text took the entire feature down with it.
  //
  // Sending a text is the LAST and least important thing that request does.
  // It must never be able to fail the rest of it.
  let claim;
  try {
    claim = (
      await rpc("claim_sms", {
        p_kind: kind,
        p_phone: phone,
        p_body: body,
        p_lead_id: leadId,
        p_customer_id: customerId,
        p_quote_id: quoteId,
        p_job_id: jobId,
        p_sent_by: sentBy,
        p_force: force,
      })
    )?.[0];
  } catch (err) {
    const message = String(err?.message || err);
    // Named, because this one has a one-line fix and is otherwise a mystery.
    if (/could not find the function/i.test(message)) {
      return { ok: false, reason: "no_sms_tables" };
    }
    return { ok: false, reason: message };
  }

  if (!claim?.ok) {
    return { ok: false, reason: claim?.reason || "not_claimed" };
  }

  try {
    // The claim stored the number in E.164; send to THAT rather than to what
    // was passed in, so Quo always gets the normalised form and the row
    // and the message can never disagree about who was texted.
    const sid = await postToQuo(claim.phone, body);
    await rpc("mark_sms_sent", { p_id: claim.id, p_sid: sid || null });
    return { ok: true, id: claim.id, sid };
  } catch (err) {
    // Never rethrow. The row is already claimed; leaving it that way would
    // hold the dedupe slot until the sweep and silently skip this person on
    // the next run.
    await rpc("mark_sms_failed", {
      p_id: claim.id,
      p_error: String(err?.message || err),
    }).catch(() => {});
    return { ok: false, reason: String(err?.message || err), id: claim.id };
  }
}

// Mirrors sb_sms_e164() in db/sms.sql. Kept in step with it deliberately —
// if the two ever disagree, the database is right.
export function toE164(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  if (/^[2-9]\d{9}$/.test(d)) return `+1${d}`;
  if (/^1[2-9]\d{9}$/.test(d)) return `+${d}`;
  return null;
}
