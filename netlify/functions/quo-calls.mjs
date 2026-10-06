// netlify/functions/quo-calls.mjs
//
// Where Quo tells us a call finished. Subscribe this URL to `call.completed`
// in the Quo console, with the same signing secret as the SMS webhook.
//
// WHAT IT REPLACES. The Call button used to log the call itself, on click,
// before anything had happened. On a laptop — where a tel: link opens
// nothing — pressing it logged a call. On a phone, pressing it and then
// pressing cancel logged a call. Ringing out logged a call. contact_attempts
// was counting button presses, and "3 attempts, no answer" and "pressed a
// button three times" are not the same fact.
//
// Quo placed the call, so Quo knows. This is the endpoint that asks it to
// say so, and db/call-tracking.sql decides what each answer means.
//
// IT ALSO PICKS UP CALLS THE CRM NEVER SAW. Hayden ringing a customer back
// from the Quo app on the way to a job has never been in this database. From
// here on it is, with its real duration, on the right person's history —
// which is the same gap sms-inbound.mjs closed for texts typed in the app.
//
// Required Netlify environment variables:
//   QUO_WEBHOOK_SECRET          — the same one sms-inbound.mjs uses, if both
//                                 subscriptions were made with one secret.
//                                 QUO_CALL_WEBHOOK_SECRET overrides it for
//                                 the case where Quo issued a separate one.
//   SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL — to write the row.
//
// Optional:
//   QUO_FROM — the business number. Only used as a fallback for working out
//              which participant is the customer; the payload normally says.

import { rpc } from "../lib/db.mjs";
import { signatureValid } from "../lib/webhooks.mjs";
import { toE164 } from "../lib/sms.mjs";

/**
 * Pull a call out of a Quo webhook.
 *
 * Written as defensively as readEvent() in sms-inbound.mjs, and for the same
 * reason plus one. The same reason: this payload's shape belongs to somebody
 * else, and it changed once already when OpenPhone became Quo. The extra
 * one: the call events put the body under `data.resource` where the message
 * events put it under `data.object`, so the two shapes are already live at
 * the same time and a parser that knows only one of them is already wrong.
 */
export function readCall(payload) {
  const type = payload?.type || payload?.event || null;
  const data = payload?.data || payload || {};

  // `resource` on the call events, `object` on the message events, and the
  // bare body on an older shape. All three accepted rather than one.
  const obj = data.resource || data.object || data || {};
  const ctx = data.context || obj.context || {};

  const id = obj.id || payload?.id || null;

  // "incoming" / "outgoing" on the documented shape, "in" / "out" on the
  // older one. Normalised downstream by record_quo_call(), which accepts
  // every spelling of inbound it has been shown.
  const direction = obj.direction || null;

  const status = obj.status || null;

  // Seconds. Number() rather than trusting it: a string "55" compares
  // false against every numeric threshold and would silently turn a real
  // conversation into "no answer".
  const rawDuration = obj.duration ?? obj.durationSeconds ?? null;
  const duration =
    rawDuration == null || rawDuration === "" ? null : Number(rawDuration);

  // WHEN IT HAPPENED, not when this request arrived.
  //
  // Quo retries anything that is not a 2xx, so a webhook delivered twenty
  // minutes late must not put the call twenty minutes after it happened.
  // completedAt first because that is the end of the call, which is what a
  // timeline entry is about.
  const at =
    obj.completedAt || obj.answeredAt || obj.createdAt || obj.updatedAt || null;

  return {
    type,
    id,
    direction,
    status,
    duration: Number.isFinite(duration) ? duration : null,
    at,
    phone: customerNumber(obj, ctx),
    raw: obj,
  };
}

/**
 * Which of the two numbers on this call is the customer.
 *
 * `participants.external` is the one to trust: Quo has already separated its
 * own numbers from everybody else's, and it is right about which of its
 * numbers are its own in a way this code can only guess at.
 *
 * The fallbacks exist because that field is newer than the events
 * themselves. Deriving it from direction is correct but relies on the
 * payload naming `from` and `to`, which the documented call shape does not;
 * subtracting QUO_FROM from a flat participant list is last because it is
 * wrong the day somebody adds a second Quo number.
 */
export function customerNumber(obj, ctx = {}) {
  const external = ctx?.participants?.external;
  if (Array.isArray(external) && external[0]) return external[0];

  const incoming = /^(in|incoming|inbound)$/i.test(String(obj?.direction || ""));
  const byDirection = incoming ? obj?.from : obj?.to;
  if (byDirection) {
    return Array.isArray(byDirection) ? byDirection[0] ?? null : byDirection;
  }

  const flat = Array.isArray(obj?.participants) ? obj.participants : [];
  if (flat.length) {
    const ours = toE164(process.env.QUO_FROM);
    // Only when subtracting our own number leaves exactly one candidate. Two
    // left means a conference or a second workspace number, and picking the
    // first of those would file the call against whichever participant Quo
    // happened to list first.
    const theirs = flat.filter((p) => !ours || toE164(p) !== ours);
    if (theirs.length === 1) return theirs[0];
  }

  return null;
}

/**
 * Is this the event we subscribed to?
 *
 * `call.completed` is the only one with a terminal status and a duration on
 * it, which is to say the only one that can answer "did this call actually
 * happen". `call.ringing` and `call.answered` both describe a call still in
 * progress, and a row written from either would be the old optimistic
 * logging with extra steps.
 *
 * Matched loosely on purpose, and NOT on `.recording`/`.summary`/
 * `.transcript`/`.voicemail`, which are their own completions of their own
 * things and carry no call status at all.
 */
export function isCallCompleted(evt) {
  const type = String(evt.type || "").toLowerCase();
  if (type) {
    return (
      /^call\.completed$/.test(type) ||
      (/call/.test(type) &&
        /completed/.test(type) &&
        !/recording|summary|transcript|voicemail/.test(type))
    );
  }
  // No type at all. Fall back to the shape: a terminal status and an id is
  // what a completed call looks like, and nothing else Quo sends has both.
  return Boolean(evt.id && evt.status);
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read as text, sign the text. Parsing first and re-serialising changes
  // the bytes and every signature fails.
  const raw = await req.text();

  // One secret unless Quo issued two. Both subscriptions are usually made in
  // the same console with the same secret, so QUO_WEBHOOK_SECRET is the
  // normal answer and the call-specific one is the escape hatch.
  const secret = process.env.QUO_CALL_WEBHOOK_SECRET || process.env.QUO_WEBHOOK_SECRET;

  if (!secret) {
    // Refused, not waved through. An unsigned public endpoint that writes to
    // a customer's history is somewhere anyone who learns the URL can invent
    // a phone call, and "the secret isn't set yet" is not a reason to accept
    // one.
    console.error("[quo-calls] QUO_WEBHOOK_SECRET is not set; refusing");
    return new Response("Forbidden", { status: 403 });
  }

  const ok = signatureValid({
    id: req.headers.get("webhook-id"),
    timestamp: req.headers.get("webhook-timestamp"),
    body: raw,
    header: req.headers.get("webhook-signature"),
    secret,
  });

  if (!ok) {
    console.warn("[quo-calls] rejected: bad signature");
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed but unparseable. 200 rather than 400: it is genuinely from Quo,
    // and a 4xx would have them retry something that will never parse.
    console.error("[quo-calls] signed payload was not JSON");
    return new Response(null, { status: 200 });
  }

  const evt = readCall(payload);

  if (!isCallCompleted(evt)) {
    // A ringing or answered event for a call still in progress. Not an
    // error — one subscription can deliver several event types, and the
    // completion for this same call is on its way.
    return new Response(null, { status: 200 });
  }

  if (!evt.phone) {
    console.warn("[quo-calls] no customer number on a completed call", {
      type: evt.type,
      id: evt.id,
    });
    return new Response(null, { status: 200 });
  }

  try {
    const id = await rpc("record_quo_call", {
      p_call_id: evt.id,
      p_phone: evt.phone,
      p_direction: evt.direction,
      p_status: evt.status,
      p_duration: evt.duration,
      p_at: evt.at,
    });

    if (id) {
      console.log("[quo-calls] logged", {
        status: evt.status,
        duration: evt.duration,
        direction: evt.direction,
        // Last four only, the way the rest of this codebase logs numbers.
        who: String(evt.phone).slice(-4),
      });
    }
    // No else. record_quo_call() returns null for a retry, for a call that
    // did not happen, and for a number nobody in the CRM owns — all three
    // are ordinary, all three are frequent, and a log line for each would
    // bury the ones that matter.
  } catch (err) {
    // Never 5xx at Quo. It retries, and a retry of a call that WAS in fact
    // recorded is handled by the unique index — but a retry storm is not
    // handled by anything.
    console.error("[quo-calls] could not record a call", err);
  }

  return new Response(null, { status: 200 });
};

export const config = {
  path: "/api/quo-calls",
};
