// netlify/functions/sms-inbound.mjs
//
// Where a customer's reply arrives. Quo POSTs here on `message.received`.
//
// Three jobs, in this order:
//   1. STOP / START / HELP — the carrier-mandated keywords. Handled first
//      and unconditionally, because getting this wrong is the one failure
//      with a regulator attached to it.
//   2. Log it against whoever that number belongs to, so the reply shows on
//      their contact history beside the calls and the job milestones.
//   3. Optionally mirror it to a second number. Usually off: the Quo app is
//      the inbox and has already pushed the reply to both phones.
//
// THIS IS A PUBLIC ENDPOINT. It has no login, it cannot have one, and its
// URL will end up in the Quo console, in logs, and in a screenshot
// somewhere. Every request is therefore checked against the webhook
// signature before a single byte of it is believed — without that, anyone
// who learns the URL can forge a STOP for any number in the CRM, or write
// whatever they like onto a customer's history.

import { rpc } from "../lib/followUps.mjs";
import { sendSms, smsMode, toE164, postToQuo } from "../lib/sms.mjs";
import { sendItAnotherWay } from "../lib/anotherWay.mjs";

// Standard Webhooks signature checking now lives in netlify/lib/webhooks.mjs,
// shared with the Resend endpoint. Re-exported so every existing import of
// it from this module — including verify/sms-js.mjs — keeps working.
//
// IMPORTED as well as re-exported, deliberately. `export { x } from "y"` is a
// re-export and does NOT put x in this module's scope — the handler below
// calls signatureValid() directly, and with only the re-export it threw
// "signatureValid is not defined" on every request. Which is to say: the SMS
// webhook was completely broken and nothing but verify/sms-js.mjs said so.
import { signatureValid, TOLERANCE_SECONDS } from "../lib/webhooks.mjs";
export { signatureValid, TOLERANCE_SECONDS };

// The carrier keyword sets, as the CTIA defines them. Matched on the whole
// message with punctuation and case stripped: "Stop." and "STOP!" are both
// unmistakably a request to stop, and treating them as ordinary replies is
// the kind of thing that ends up in a complaint.
const STOP_WORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit",
]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

export function keyword(body) {
  const word = String(body || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}

/**
 * Pull the sender and the text out of a Quo webhook.
 *
 * Written defensively on purpose. This is the one payload in the system
 * whose shape is owned by somebody else, it changed once already when
 * OpenPhone became Quo, and the cost of a wrong guess is a reply that
 * silently never reaches anybody.
 */
export function readEvent(payload) {
  const type = payload?.type || payload?.event || null;
  const obj = payload?.data?.object || payload?.data || payload?.object || {};

  // Inbound: `from` is the customer, `to` is the business number.
  const from = obj.from || obj.participants?.[0] || null;
  const body = obj.text ?? obj.body ?? obj.content ?? "";
  const id = obj.id || payload?.id || null;
  const direction = obj.direction || null;

  // Delivery receipts. Same defensiveness as the rest of this function and
  // then some: the field that carries the carrier's REASON is the one we
  // have never seen, because it only exists on a payload that only arrives
  // when something has gone wrong.
  const status = obj.status || obj.deliveryStatus || null;
  const error =
    obj.error ||
    obj.errorMessage ||
    obj.errorCode ||
    obj.failureReason ||
    obj.reason ||
    null;

  return { type, from, body, id, direction, status, error, raw: obj };
}

/**
 * Is this Quo telling us a message did not arrive?
 *
 * KEPT, BUT IT NEVER FIRES. Quo publishes exactly two message webhooks —
 * `message.received` and `message.delivered` — and no failure event of any
 * kind. This branch was written against an event that does not exist, which
 * is why a quote to a landline still said "sent" days later: nothing was
 * ever going to tell us otherwise.
 *
 * The verdict is fetched instead, by netlify/lib/smsReconcile.mjs asking
 * GET /v1/messages/{id}. This is left in place because it costs nothing, it
 * is already tested, and if Quo ever does publish a failure event the CRM
 * will pick it up the day it is ticked — a webhook beats polling when one is
 * available, because it arrives in seconds rather than at the next run.
 */
/**
 * The one delivery event Quo actually sends.
 *
 * Matched on the status as well as the type, because readEvent() pulls the
 * status out of several shapes and a payload that says `status: "delivered"`
 * means the same thing whatever its type is called.
 *
 * "delivery_delayed" must not match. A delayed message has not arrived, and
 * treating it as delivered would stop the reconciler ever asking about it
 * again — the message would be marked as having reached a handset it never
 * reached, permanently, which is the exact failure this whole feature
 * exists to prevent.
 */
export function isDelivered(evt) {
  const status = String(evt.status || "").toLowerCase();
  if (status === "delivered") return true;

  const type = String(evt.type || "").toLowerCase();
  return /message\.delivered/.test(type) && !/delay/.test(type);
}

export function isDeliveryFailure(evt) {
  const status = String(evt.status || "").toLowerCase();
  if (status === "failed" || status === "undelivered") return true;

  const type = String(evt.type || "").toLowerCase();
  return /message\.(failed|undelivered)/.test(type);
}

/**
 * The carrier's reason, in the carrier's words, or an honest admission that
 * we could not find one.
 *
 * When nothing matches, the keys of the payload are logged once. Quo owns
 * this shape and has changed it before; a guess that silently resolves to
 * "unknown" would leave sb_sms_permanent() unable to tell a landline from a
 * spam filter forever, and nobody would ever find out why. The log is how
 * the first real failure tells us what the field is actually called.
 */
export function failureReason(evt) {
  if (typeof evt.error === "string" && evt.error.trim()) return evt.error.trim();

  if (evt.error && typeof evt.error === "object") {
    const nested = evt.error.message || evt.error.description || evt.error.code;
    if (nested) return String(nested);
  }

  console.warn("[sms-inbound] delivery failure with no reason field", {
    type: evt.type,
    status: evt.status,
    keys: Object.keys(evt.raw || {}),
  });

  return evt.status ? `carrier reported ${evt.status}` : "carrier did not deliver it";
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read as text, sign the text. Parsing first and re-serialising changes
  // the bytes and every signature fails.
  const raw = await req.text();

  const ok = signatureValid({
    id: req.headers.get("webhook-id"),
    timestamp: req.headers.get("webhook-timestamp"),
    body: raw,
    header: req.headers.get("webhook-signature"),
    secret: process.env.QUO_WEBHOOK_SECRET,
  });

  if (!ok) {
    // Terse, and a 403 rather than a 401: there is nothing to authenticate
    // with and nothing useful to say to whoever sent this.
    console.warn("[sms-inbound] rejected: bad signature");
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed but unparseable. 200 rather than 400: it is genuinely from Quo,
    // and a 4xx would have them retry something that will never parse.
    console.error("[sms-inbound] signed payload was not JSON");
    return new Response(null, { status: 200 });
  }

  const evt = readEvent(payload);

  // A delivery receipt saying the message did not arrive. Handled BEFORE the
  // gate below, which exists to throw away outbound copies — and a failure
  // receipt is an outbound copy, so it was being thrown away with them.
  // That is why a quote to a landline sat on the board as sent.
  // It arrived. A real Quo event, and worth subscribing to: every delivery
  // confirmed here is a message the nightly reconciler then never has to ask
  // about, and the answer arrives in seconds instead of at 4pm tomorrow.
  //
  // Recorded as a TIMESTAMP, never as a status. A 'delivered' status would
  // drop the row out of the double-send index and free its dedupe slot —
  // confirming delivery would cause a second send. See the header of
  // db/delivery-controls.sql.
  if (isDelivered(evt)) {
    try {
      if (evt.id) await rpc("mark_sms_delivered", { p_sid: evt.id });
    } catch (err) {
      console.error("[sms-inbound] could not record a delivery", err);
    }
    return new Response(null, { status: 200 });
  }

  if (isDeliveryFailure(evt)) {
    try {
      const row = await recordUndelivered(evt);
      if (row) await sendItAnotherWay(row, { origin: new URL(req.url).origin });
    } catch (err) {
      // Same rule as everything else here: never 5xx at Quo. A retry of a
      // receipt we have already recorded is harmless — mark_sms_undelivered
      // is idempotent — but a retry storm is not.
      console.error("[sms-inbound] could not record a delivery failure", err);
    }
    return new Response(null, { status: 200 });
  }

  // Quo sends delivery receipts and outbound copies through the same hook.
  // Acting on those would log every message the CRM itself sent a second
  // time, as though the customer had said it.
  if (evt.direction === "outgoing" || (evt.type && !/received/i.test(evt.type))) {
    return new Response(null, { status: 200 });
  }

  if (!evt.from) {
    console.warn("[sms-inbound] no sender on a received event", { type: evt.type });
    return new Response(null, { status: 200 });
  }

  const word = keyword(evt.body);

  try {
    // Keywords first. A STOP is recorded before anything else touches the
    // database, so a crash further down cannot lose it.
    if (word === "stop") {
      await rpc("record_sms_opt_out", {
        p_phone: evt.from,
        p_body: evt.body,
        p_source: "stop",
      });
      await logInbound(evt);
      // No confirmation sent from here. The carrier sends one, and a second
      // message from us would be the last thing someone gets after asking
      // not to be messaged.
      console.log("[sms-inbound] opt-out", { from: String(evt.from).slice(-4) });
      return new Response(null, { status: 200 });
    }

    if (word === "start") {
      await rpc("record_sms_opt_in", { p_phone: evt.from });
      await logInbound(evt);
      console.log("[sms-inbound] opt-in", { from: String(evt.from).slice(-4) });
      return new Response(null, { status: 200 });
    }

    await logInbound(evt);

    if (word === "help") {
      // Through sendSms so it is claimed, logged and subject to the same
      // rules as everything else. force: true — somebody asking for help at
      // 10pm should get an answer at 10pm.
      await sendSms({
        kind: "manual",
        phone: evt.from,
        body:
          "Sky Blue Cleaning Co., Corvallis OR. Call or text (541) 730-3593. " +
          "Reply STOP to opt out.",
        force: true,
      });
      return new Response(null, { status: 200 });
    }

    await mirror(evt);
  } catch (err) {
    // Never 5xx at Quo. It retries, and a retry of a message that was in
    // fact recorded is how one reply becomes four rows.
    console.error("[sms-inbound] handling failed", err);
  }

  return new Response(null, { status: 200 });
};

async function logInbound(evt) {
  await rpc("record_inbound_sms", {
    p_phone: evt.from,
    p_body: evt.body,
    p_sid: evt.id,
  });
}

// Copy the reply to another number. Off unless SMS_FORWARD_TO is set, and it
// usually should be: Quo's own app already pushed this to both phones, so
// turning it on means paying for a second notification of something you have
// already been notified about.
//
// Deliberately NOT through sendSms(): that would claim a row, write a
// contact_log entry and count a contact attempt against a customer — for a
// message sent to ourselves. An internal notification is not outreach and
// must never appear on anybody's history.
async function mirror(evt) {
  const to = toE164(process.env.SMS_FORWARD_TO);
  if (!to || smsMode() !== "send") return;

  try {
    await postToQuo(
      to,
      // Truncated: this is a notification, not an archive. The whole message
      // is already on the customer's record, and a long one would otherwise
      // cost several segments to say what can be read there in full.
      `Sky Blue text from ${evt.from}: ${String(evt.body).slice(0, 240)}`
    );
  } catch (err) {
    console.error("[sms-inbound] mirror failed", err);
  }
}

export const config = {
  path: "/api/sms-inbound",
};

/**
 * Write the carrier's verdict against the message it belongs to.
 *
 * Quo's message id is the only handle we have — the webhook knows nothing
 * about leads or quotes — and it is stored on sms_messages.provider_sid by
 * mark_sms_sent() when the send was accepted. mark_sms_undelivered() does
 * the rest: flips the row, decides whether the refusal was permanent, and
 * closes the number if it was.
 *
 * Returns the row it changed, or null when there was nothing to change —
 * an id we have never seen, or a receipt that already arrived. The caller
 * needs that difference, because "send the quote by email instead" must
 * happen once and not once per webhook retry.
 */
async function recordUndelivered(evt) {
  if (!evt.id) {
    console.warn("[sms-inbound] a delivery failure with no message id", {
      type: evt.type,
    });
    return null;
  }

  const reason = failureReason(evt);
  const rows = await rpc("mark_sms_undelivered", {
    p_sid: evt.id,
    p_error: reason,
  });

  const row = Array.isArray(rows) ? rows[0] : rows;

  if (!row?.out_id) {
    // Not an error. Quo delivers at least once and retries anything that
    // isn't a 2xx, so a second receipt for a message already marked is the
    // normal case, not a surprise.
    return null;
  }

  console.log("[sms-inbound] undelivered", {
    kind: row.out_kind,
    permanent: row.out_permanent,
    reason,
    // Last four only. The rest of this file logs numbers the same way.
    to: String(row.out_phone || "").slice(-4),
  });

  return row;
}
