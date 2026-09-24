// netlify/lib/webhooks.mjs
//
// Checking that a webhook really came from who it says.
//
// Lived in sms-inbound.mjs, because Quo was the only thing posting to this
// CRM. Resend is the second — db/email-delivery.sql adds an endpoint for
// bounce and complaint events — and both use Standard Webhooks, the same
// scheme with the same headers.
//
// Two copies of a signature verifier is how one of them quietly stops being
// maintained. sms-inbound.mjs re-exports this so its own tests, and anything
// else importing it from there, keep working.

import crypto from "node:crypto";

// How far out of date a request may be. Standard Webhooks asks for a
// tolerance without naming one; five minutes is the usual choice and is what
// stops a captured request being replayed tomorrow.
export const TOLERANCE_SECONDS = 5 * 60;

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


/**
 * Pull the three Standard Webhooks headers off a request.
 *
 * Case-insensitive because Headers is, and named here so a caller cannot
 * quietly misspell one and get an undefined that reads as "unsigned".
 */
export function webhookHeaders(req) {
  return {
    id: req.headers.get("webhook-id") || req.headers.get("svix-id"),
    timestamp:
      req.headers.get("webhook-timestamp") || req.headers.get("svix-timestamp"),
    header:
      req.headers.get("webhook-signature") || req.headers.get("svix-signature"),
  };
}
