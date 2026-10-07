// netlify/functions/send-text.mjs
//
// Somebody in the CRM typed a text and pressed send.
//
// NOT TO BE CONFUSED WITH send-sms.mjs, which is the nightly scheduled run
// and takes no input. This one is the composer at the bottom of a thread:
// one message, to one number, written by a person who is looking at the
// conversation.
//
// WHY THIS IS AN ENDPOINT AND NOT A SUPABASE RPC. Sending needs the Quo API
// key. The browser cannot have the Quo API key — it is a bearer credential
// for an account that can text anybody in the United States, and shipping it
// to a phone on a driveway puts it in the devtools of every machine the CRM
// is ever opened on. So the browser asks this, this asks Quo, and the key
// never leaves Netlify.
//
// IT HOLDS ALMOST NO LOGIC, ON PURPOSE. Everything that decides whether a
// text may go out — the opt-out, quiet hours, the double-send index, the
// mode switch — is in claim_sms() and sendSms(), and is reached by every
// other sender in this system. A composer that posted straight to Quo would
// be a second way to send a text with none of those rules attached, and it
// would be the one that texts somebody who replied STOP.
//
// Environment: the same ones sendSms() already needs — QUO_API_KEY,
// QUO_FROM, SMS_MODE, SUPABASE_SERVICE_ROLE_KEY — plus VITE_SUPABASE_URL
// and VITE_SUPABASE_ANON_KEY to check who is calling.

import { rpc } from "../lib/db.mjs";
import { sendSms, segmentsFor } from "../lib/sms.mjs";
// One copy, shared with backfill-texts.mjs. See netlify/lib/whoIs.mjs.
import { whoIs } from "../lib/whoIs.mjs";

// Quo accepts up to 1600 characters in one API call; past that it is
// rejected outright. Refused here with a sentence somebody can act on,
// rather than passed through to come back as a provider error.
//
// Ten segments is also about forty cents and six separate notifications on
// the customer's lock screen, so the limit is doing more than one job.
const MAX_CHARS = 1600;


/**
 * The reasons sendSms() can give, in words for somebody holding a phone.
 *
 * Every one of these is a state a person can be looking at, so every one of
 * them says what is true and what would change it. "Couldn't send" with no
 * reason is the message that makes somebody press the button four more
 * times.
 */
export function sendProblem(reason) {
  switch (reason) {
    case "opted_out":
      return "This number replied STOP, so we can't text it. Call them instead.";
    case "sms_off":
      return "Texting is switched off. Set SMS_MODE=send in Netlify to turn it on.";
    case "preview":
      return "SMS_MODE is set to preview, so nothing was actually sent.";
    case "not_configured":
      return "Texting isn't set up yet — QUO_API_KEY and QUO_FROM are missing in Netlify.";
    case "no_sms_tables":
      return "Run db/sms.sql in Supabase — the texting tables aren't there yet.";
    case "bad_number":
      return "That isn't a number we can text. US numbers only, ten digits.";
    case "empty_body":
      return "Nothing to send.";
    case "quiet_hours":
      // Reachable only if force stops being passed below. Named anyway: a
      // silent "not sent" with no explanation is the failure this whole
      // function is written to avoid, and the day somebody changes that
      // argument is the day this string earns its keep.
      return "It's outside texting hours.";
    case "already_sent":
      return "That one has already gone out.";
    default:
      return reason ? `Couldn't send: ${reason}` : "Couldn't send that text.";
  }
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  const userId = await whoIs(req);
  if (!userId) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  let input;
  try {
    input = await req.json();
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }

  const body = String(input?.body ?? "").trim();
  const phone = input?.phone ?? null;
  let leadId = input?.leadId ?? null;
  let customerId = input?.customerId ?? null;

  if (!phone) {
    return Response.json({ error: "No number to text." }, { status: 400 });
  }
  if (!body) {
    return Response.json({ error: sendProblem("empty_body") }, { status: 400 });
  }
  if (body.length > MAX_CHARS) {
    return Response.json(
      {
        error: `That's ${body.length} characters and the limit is ${MAX_CHARS}. Send it in two.`,
      },
      { status: 400 }
    );
  }

  // Stamp BOTH ids where we can, not just the one the page happened to have.
  //
  // The thread is keyed on the phone number — a person is routinely a lead
  // and a customer at once, and the conversation is one conversation. The
  // message rows should say so too: a text sent from the lead page that
  // carries only a lead_id is invisible to anything reading by customer_id,
  // which includes the contact timeline on the customer's own profile.
  //
  // Best-effort. A failure here loses a cross-reference; refusing to send
  // over it would lose the message.
  try {
    const ids = (
      await rpc("sms_thread_ids", { p_lead_id: leadId, p_customer_id: customerId })
    )?.[0];
    if (ids) {
      leadId = leadId || ids.lead_id || null;
      customerId = customerId || ids.customer_id || null;
    }
  } catch (err) {
    console.error("[send-text] could not resolve the other id", err);
  }

  const result = await sendSms({
    kind: "manual",
    phone,
    body,
    leadId,
    customerId,
    sentBy: userId,
    // A person is looking at this conversation and chose to answer it.
    //
    // force skips QUIET HOURS and nothing else. Quiet hours exist to stop
    // the CRM starting conversations at 8:45pm; they are not a reason to
    // refuse to let Hayden answer a customer who texted him at 8:45pm. The
    // opt-out has no override anywhere in this codebase, including here,
    // and claim_sms() is where that is enforced rather than here — so this
    // argument cannot be the thing that texts somebody who said STOP.
    force: true,
  });

  if (!result.ok) {
    // 200, not 4xx, for "we decided not to send this".
    //
    // An opt-out is not a client error — the request was perfectly well
    // formed and the answer is no. Returning 4xx would have fetch wrappers
    // and error boundaries treat a correct, expected outcome as a fault,
    // and the thread would show "something went wrong" for the one case
    // where the CRM knows exactly what happened and why.
    return Response.json(
      { ok: false, reason: result.reason, error: sendProblem(result.reason) },
      { status: 200 }
    );
  }

  return Response.json({
    ok: true,
    id: result.id,
    sid: result.sid,
    // So the composer can say "2 segments" without re-deriving it from a
    // second copy of the GSM-7 table.
    segments: segmentsFor(body).segments,
  });
};

export const config = {
  path: "/api/send-text",
};
