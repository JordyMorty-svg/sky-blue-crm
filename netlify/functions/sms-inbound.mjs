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

import crypto from "node:crypto";
import { rpc } from "../lib/followUps.mjs";
import { sendSms, smsMode, toE164, postToQuo } from "../lib/sms.mjs";
import { emailTheQuote } from "../lib/quoteEmail.mjs";

// How far out of date a request may be. Standard Webhooks asks for a
// tolerance without naming one; five minutes is the usual choice and is what
// stops a captured request being replayed tomorrow.
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Standard Webhooks, which is what Quo moved to when it replaced the older
 * OpenPhone-Signature header.
 *
 * The signed string is `id.timestamp.body` — the RAW body, exactly as it
 * arrived. Re-serialising the JSON first is the classic way to break this:
 * key order and whitespace both change the bytes and therefore the hash.
 *
 * Implemented here rather than pulling in the Svix SDK: it is thirty lines,
 * it is the only part of that package we would use, and a signature verifier
 * whose implementation you cannot read is a strange thing to trust.
 */
export function signatureValid({ id, timestamp, body, header, secret, now = Date.now() }) {
  if (!id || !timestamp || !header || !secret) return false;

  // Replay guard, before any cryptography.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;

  // whsec_ prefixes a base64 secret. The bytes it decodes to are the HMAC
  // key — hashing the printable string instead produces a signature that is
  // wrong in a way nothing reports.
  const raw = String(secret).startsWith("whsec_") ? String(secret).slice(6) : String(secret);
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");

  // The header is a space-delimited list, so a secret can be rotated without
  // downtime — both the old and the new signature ride along until the old
  // one is retired. Any one matching is a pass.
  for (const part of String(header).split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;

    const a = Buffer.from(expected);
    const b = Buffer.from(value);
    // Length-checked first: timingSafeEqual throws on a mismatch, and an
    // attacker sending one character would otherwise 500 the endpoint —
    // which Quo treats as retryable and hammers.
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }

  return false;
}

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
 * Read from two places because Quo says it in two ways — a `message.failed`
 * event type, and a `status` of failed or undelivered on a `message.updated`.
 * Either one is the carrier's verdict and both have to count, because
 * missing it means the CRM goes on believing a quote was delivered.
 *
 * `message.delivered` is deliberately NOT handled. It would be nice to
 * record, but 'sent' already leaves the double-send guard closed and adding
 * a 'delivered' state would mean widening that index again — a lot of risk
 * for a green tick. See the note at the top of db/sms-delivery.sql.
 */
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
  if (isDeliveryFailure(evt)) {
    try {
      const row = await recordUndelivered(evt);
      if (row) await sendItAnotherWay(row, req);
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

/**
 * The text didn't arrive, so try the other address we have.
 *
 * Quotes only. A reminder or a nudge that doesn't arrive is worth knowing
 * about — that is what the failures list is for — but it is not worth
 * inventing an email template for, and "your appointment is tomorrow" landing
 * in an inbox nobody checks is not better than nothing, it just looks like
 * it is.
 *
 * Runs once per failure and not once per webhook retry, because
 * mark_sms_undelivered() only returns a row the first time. That is the
 * whole reason it returns anything at all.
 *
 * Never throws. Every caller of this is a webhook handler that must answer
 * 200 or Quo will send the receipt again.
 */
async function sendItAnotherWay(row, req) {
  if (row.out_kind !== "quote" || !row.out_quote_id) return;

  try {
    const rows = await rpc("quote_for_email", { p_quote_id: row.out_quote_id });
    const q = Array.isArray(rows) ? rows[0] : rows;

    // No row means no address to send to, which is ordinary for a lead taken
    // over the phone — not a failure, and nothing to log loudly.
    if (!q?.out_email || !q?.out_token) return;

    const base = (
      process.env.PUBLIC_URL ||
      process.env.URL ||
      new URL(req.url).origin
    ).replace(/\/$/, "");

    const sent = await emailTheQuote({
      to: q.out_email,
      customerName: q.out_name,
      amount: Number(q.out_amount) || 0,
      link: `${base}/q/${q.out_token}`,
      expires: q.out_expires
        ? new Date(q.out_expires).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
          })
        : null,
    });

    console.log("[sms-inbound] quote fell back to email", {
      ok: sent.ok,
      reason: sent.reason || null,
    });
  } catch (err) {
    // The status is already recorded and the failures list will show it.
    // Losing the fallback is a smaller failure than losing the record of
    // why the fallback was needed.
    console.error("[sms-inbound] could not email the quote instead", err);
  }
}
