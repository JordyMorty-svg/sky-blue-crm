// netlify/lib/smsReconcile.mjs
//
// Asking Quo what became of the texts we sent.
//
// This exists because the thing db/sms-delivery.sql was built around does
// not exist. Quo publishes two message webhooks — `message.received` and
// `message.delivered` — and no failure event of any kind. So the delivery
// branch in sms-inbound.mjs was waiting for a message that was never coming,
// and a quote to a landline stayed "sent" forever.
//
// What Quo does have is the status on the message itself:
//
//     GET /v1/messages/{id}  ->  queued | sent | delivered | undelivered | received
//
// We already store Quo's id in provider_sid on every send. It was put there
// for the webhook; it turns out to be the thing that actually works.
//
// Asking rather than being told has one property a webhook could never have:
// it is RETROACTIVE. Every quote already sent gets its real verdict on the
// first run, including the ones that failed weeks ago.

import { rpc } from "./db.mjs";
import { QUO_BASE } from "./sms.mjs";
import { sendItAnotherWay } from "./anotherWay.mjs";

/**
 * One message's verdict, straight from Quo.
 *
 * Returns { status, error } or null when Quo can't answer. Null is
 * deliberately different from a status: "we don't know" must not be recorded
 * as "it failed", or a Quo outage would mark every recent message as
 * undelivered and close every number in the address book.
 */
export async function askQuo(sid, { fetchImpl = fetch } = {}) {
  const key = process.env.QUO_API_KEY;
  if (!key) throw new Error("QUO_API_KEY is not set");

  const res = await fetchImpl(`${QUO_BASE()}/messages/${encodeURIComponent(sid)}`, {
    // The API key goes in bare. NOT "Bearer " — Quo's docs are explicit, and
    // prefixing it fails with a 401 that looks exactly like a wrong key.
    headers: { Authorization: key },
  });

  if (res.status === 404) {
    // Quo has never heard of it. Almost always a message sent from the
    // temporary number before the port, which no longer resolves. Not a
    // delivery failure — there is nothing to record.
    return { status: "unknown", error: null };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Quo ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const payload = await res.json().catch(() => ({}));
  const data = payload?.data || payload || {};

  return {
    status: String(data.status || "").toLowerCase() || null,
    // Not in Quo's documented message object, but read anyway: if they ever
    // add a reason it is worth having, and sb_sms_permanent() is written to
    // treat an unrecognised reason as NOT permanent, so a surprise here
    // cannot suppress anybody by accident.
    error: data.error || data.errorMessage || data.failureReason || null,
  };
}

/**
 * One pass.
 *
 * Serial, not Promise.all. Quo allows ten requests a second and the volume
 * here is a few dozen; there is nothing to gain from parallelism and a
 * rate-limit rejection to lose.
 *
 * Never throws for one bad message. A single unreadable row must not abandon
 * the rest of the batch — the whole point of a catch-up pass is that it
 * catches up.
 */
export async function reconcileSms({ limit = 100, days = 7, fetchImpl = fetch } = {}) {
  if (!process.env.QUO_API_KEY) {
    return { checked: 0, error: "QUO_API_KEY is not set" };
  }

  const rows = (await rpc("sms_awaiting_verdict", { p_limit: limit, p_days: days })) || [];

  let delivered = 0;
  let undelivered = 0;
  let stillWaiting = 0;
  let unknown = 0;
  const failures = [];
  const problems = [];

  for (const row of rows) {
    const sid = row.out_sid;
    if (!sid) continue;

    let verdict;
    try {
      verdict = await askQuo(sid, { fetchImpl });
    } catch (err) {
      // Logged and skipped. It will be picked up on the next pass, because
      // nothing about the row changed.
      problems.push({ sid, reason: String(err?.message || err) });
      continue;
    }

    if (verdict.status === "delivered") {
      await rpc("mark_sms_delivered", { p_sid: sid });
      delivered += 1;
      continue;
    }

    if (verdict.status === "undelivered") {
      // The same function the webhook branch calls, so a verdict discovered
      // by asking and one that arrived by being told produce identical rows.
      // It returns nothing the second time, which is what keeps this
      // idempotent across nightly runs.
      const result = await rpc("mark_sms_undelivered", {
        p_sid: sid,
        p_error: verdict.error || "Quo reports the carrier did not deliver it",
      });
      const rec = Array.isArray(result) ? result[0] : result;
      if (rec) {
        undelivered += 1;

        /*
         * Now try the other address.
         *
         * THIS is the line that was missing, and it made the whole "email it
         * instead" feature dead code. The fallback only existed inside the
         * delivery-failure webhook branch — and Quo has no delivery-failure
         * webhook. It was written, tested and shipped, and could never once
         * have run.
         *
         * It matters most for the day-before confirmation, which is the one
         * message that expires overnight: discovering at 4pm that this
         * afternoon's reminder was refused is only useful if something then
         * emails it.
         *
         * Safe to call on every pass because mark_sms_undelivered() only
         * returns a row the FIRST time. A repeat gives nothing back and we
         * never get here, so a customer cannot be emailed the same fallback
         * quote once every fifteen minutes.
         */
        const second = await sendItAnotherWay(rec);

        failures.push({
          kind: rec.out_kind,
          permanent: rec.out_permanent,
          emailed: second?.sent === true,
          // Last four only. The rest of this codebase logs numbers the same
          // way; a full number in a build log is a number in a build log.
          to: String(rec.out_phone || "").slice(-4),
        });
      }
      continue;
    }

    if (verdict.status === "unknown") unknown += 1;
    else stillWaiting += 1;
  }

  return {
    checked: rows.length,
    delivered,
    undelivered,
    still_waiting: stillWaiting,
    unknown,
    failures,
    problems,
  };
}
