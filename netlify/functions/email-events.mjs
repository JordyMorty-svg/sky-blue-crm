// netlify/functions/email-events.mjs
//
// Where Resend tells us what became of an email.
//
// Sending an email is two separate events and the CRM only ever saw the
// first — exactly the same gap db/sms-delivery.sql closed for texts. Resend
// accepts the message and answers with an id; the receiving server decides
// whether to take it a second or two later, or a person marks it as spam
// days later, and both of those arrive here.
//
// Setup, in the Resend dashboard -> Webhooks -> Add endpoint:
//
//     https://crm.skybluecleaningco.com/.netlify/functions/email-events
//
// with email.bounced, email.complained and email.delivered ticked, and the
// signing secret pasted into Netlify as RESEND_WEBHOOK_SECRET.
//
// THIS IS A PUBLIC ENDPOINT. Same rules as sms-inbound.mjs: every request is
// checked against the signature before a byte of it is believed. Without
// that, anyone who learns the URL can mark any customer's address as
// bouncing and quietly cut them off from every email the business sends.

import { rpc } from "../lib/db.mjs";
import { signatureValid, webhookHeaders } from "../lib/webhooks.mjs";

/**
 * What kind of event this is, in our words.
 *
 * Written defensively. Resend's payload shape is theirs to change, and this
 * runs unattended on somebody else's schedule — a field moving one level
 * deeper should mean one event is not understood, not that the endpoint
 * throws and Resend starts retrying it every few minutes forever.
 */
export function readEmailEvent(payload) {
  const type = String(payload?.type || payload?.event || "").toLowerCase();
  const data = payload?.data || payload || {};

  // Resend sends `to` as an array. One recipient always, because every email
  // this CRM sends is to one household — but read as an array anyway rather
  // than assuming, because assuming is how the address comes out as
  // "[object Object]" and suppresses nobody.
  const to = Array.isArray(data.to) ? data.to[0] : data.to;

  const bounce = data.bounce || {};
  const reason =
    bounce.message ||
    bounce.subType ||
    bounce.type ||
    data.reason ||
    data.error ||
    null;

  let status = null;
  if (type.includes("bounce")) status = "bounced";
  else if (type.includes("complain")) status = "complained";
  else if (type.includes("deliver") && !type.includes("delay")) status = "delivered";

  return {
    type,
    status,
    providerId: data.email_id || data.id || null,
    to: to || null,
    subject: data.subject || null,
    // A Permanent bounce type from Resend is authoritative and outranks any
    // guess made from the wording. Passed through in the reason so
    // sb_email_permanent() sees the word it matches on.
    reason:
      bounce.type && reason && !String(reason).toLowerCase().includes(String(bounce.type).toLowerCase())
        ? `${bounce.type}: ${reason}`
        : reason,
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // The RAW body, read once and never re-serialised. Re-encoding the JSON
  // before hashing it is the classic way to break a signature check: key
  // order and whitespace both change the bytes.
  const body = await req.text();

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Refused, not waved through. An endpoint that accepts unsigned events
    // when a variable is missing is an endpoint that is unsigned in
    // production the first time somebody restores Netlify's env from a
    // backup — and it would look like it was working.
    console.error("[email-events] RESEND_WEBHOOK_SECRET is not set; refusing");
    return new Response("Not configured", { status: 503 });
  }

  const { id, timestamp, header } = webhookHeaders(req);
  if (!signatureValid({ id, timestamp, body, header, secret })) {
    console.warn("[email-events] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    // 200, deliberately. The request was genuinely from Resend — it passed
    // the signature — so retrying it will produce the same unparseable
    // thing. Answering 400 just makes them send it again.
    console.error("[email-events] signed but unparseable");
    return Response.json({ ok: true, ignored: "unparseable" });
  }

  const evt = readEmailEvent(payload);

  // Opens, clicks, delivery delays. Acknowledged and dropped.
  if (!evt.status) {
    return Response.json({ ok: true, ignored: evt.type || "unknown" });
  }

  try {
    if (evt.status === "delivered") {
      await rpc("mark_email_delivered", { p_provider_id: evt.providerId });
      return Response.json({ ok: true, delivered: true });
    }

    const rows = await rpc("mark_email_failed", {
      p_provider_id: evt.providerId,
      p_to: evt.to,
      p_status: evt.status,
      p_error: evt.reason,
    });

    const row = Array.isArray(rows) ? rows[0] : rows;

    // No row means this is a retry of an event already recorded. Nothing to
    // do and nothing to log — that is the function working.
    if (!row) return Response.json({ ok: true, duplicate: true });

    console.log(
      "[email-events]",
      JSON.stringify({
        status: evt.status,
        kind: row.out_kind,
        permanent: row.out_permanent,
        customer: row.out_customer_id || row.out_lead_id || null,
      })
    );

    return Response.json({ ok: true, recorded: true, permanent: row.out_permanent });
  } catch (err) {
    // 500 here is correct, and it is the one place it is. The event was
    // real and we failed to write it down; Resend retrying is exactly what
    // should happen, and swallowing it would lose the record for good.
    console.error("[email-events] could not record", err);
    return new Response("Could not record", { status: 500 });
  }
};
