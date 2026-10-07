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
 * Did this request really come from Quo?
 *
 * The signed string covers the RAW body, exactly as it arrived.
 * Re-serialising the JSON first is the classic way to break this: key order
 * and whitespace both change the bytes and therefore the hash.
 *
 * Implemented here rather than pulling in the Svix SDK: it is forty lines, it
 * is the only part of that package we would use, and a signature verifier
 * whose implementation you cannot read is a strange thing to trust.
 */
export function signatureValid(args) {
  return signatureProblem(args) === null;
}

/**
 * Which signing scheme this request arrived in, and what it signed.
 *
 * TWO ARE LIVE AT ONCE, which is the whole reason this is a function.
 *
 *   Standard Webhooks — `webhook-signature: v1,<base64> v1,<base64>` with
 *   `webhook-id` and `webhook-timestamp` beside it, signing
 *   `id.timestamp.body`. Space-separated so a secret can be rotated without
 *   downtime: the old and the new signature both ride along until the old one
 *   is retired.
 *
 *   The older OpenPhone scheme — `openphone-signature: hmac;1;<ts>;<base64>`,
 *   which carries its own timestamp and signs `timestamp.body`. Quo's docs
 *   describe the unified webhook in Standard Webhooks terms, but the older
 *   header is what every OpenPhone integration written before the rename is
 *   verifying, and a subscription created through the older console may well
 *   still send it. Accepting both costs one HMAC and removes a whole class of
 *   "the secret is right and it still 403s".
 *
 * Returns null when neither scheme is present, so the caller can say so
 * rather than reporting a mismatch against a signature that was never there.
 */
export function parseSignature({ id, timestamp, header, legacy }) {
  const v1 = String(header || "")
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => value);

  if (v1.length) {
    return {
      scheme: "Standard Webhooks",
      timestamp,
      signed: (body) => `${id}.${timestamp}.${body}`,
      values: v1,
      needsId: true,
    };
  }

  // hmac;<version>;<timestamp>;<signature>. The version field is read and
  // ignored: there has only ever been a 1, and refusing a 2 we have never
  // seen would be refusing the thing we are trying to accept.
  const parts = String(legacy || "").split(";");
  if (parts.length === 4 && parts[0] === "hmac" && parts[2] && parts[3]) {
    return {
      scheme: "OpenPhone hmac",
      timestamp: parts[2],
      signed: (body) => `${parts[2]}.${body}`,
      values: [parts[3]],
      needsId: false,
    };
  }

  return null;
}

/**
 * A webhook timestamp in seconds, whatever unit it arrived in.
 *
 * QUO SENDS MILLISECONDS. Standard Webhooks specifies seconds, every
 * reference implementation reads seconds, and Quo's `webhook-timestamp` is a
 * millisecond epoch. So the replay guard compared a value around 1.79e12
 * against a clock around 1.79e9 and refused every request ever sent — with
 * "bad signature", which is how this cost two evenings. The log line that
 * finally said it was:
 *
 *   rejected: the signature timestamp is -1789551345639s away from now,
 *   outside the 300s tolerance
 *
 * A number that large is not a clock problem and not a replay; it is a unit.
 * That line is the entire argument for naming a refusal instead of printing
 * "bad signature": the cause was in the number, and nothing was printing the
 * number.
 *
 * TEN DIGITS OR THIRTEEN, and there is no ambiguity to agonise over: as
 * seconds, 1e11 is the year 5138, so anything above it is not a second count
 * anybody meant. The threshold cannot be reached from the other direction
 * either — a millisecond epoch has been above 1e11 since 1973.
 *
 * ONLY THE REPLAY WINDOW USES THIS. The signed string must carry the
 * timestamp EXACTLY as the header spelled it, because that is what Quo
 * hashed; normalising it before signing would break every signature.
 */
export function secondsFrom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1e11 ? n / 1000 : n;
}

/**
 * Every HMAC key one configured secret could reasonably mean.
 *
 * TWO ENCODINGS, and this is not belt-and-braces for its own sake.
 *
 * A Standard Webhooks secret is `whsec_` followed by base64, and the bytes it
 * decodes to are the key — hashing the printable string instead produces a
 * signature that is wrong in a way nothing reports. But not every provider
 * hands out a base64 secret, and a console that shows you a plain string
 * means the string itself is the key. Both are tried because the two are
 * indistinguishable by eye: `whsec_` or not, every value here is "some
 * characters from a web page", and getting it wrong looks exactly like
 * getting the secret wrong.
 *
 * No try/catch around the decode: Buffer.from(s, "base64") does not throw, it
 * drops the characters it does not recognise. Mutation testing could not kill
 * a catch branch nothing reaches.
 */
export function keysFor(secret) {
  // whsec_ marks base64 explicitly, so when it is there the literal reading
  // of the string is not a candidate — it would be the prefix and all.
  const prefixed = secret.startsWith("whsec_");
  const raw = prefixed ? secret.slice(6) : secret;

  const keys = [Buffer.from(raw, "base64")];
  if (!prefixed) keys.push(Buffer.from(secret, "utf8"));

  // "whsec_" on its own, or "==", or any value that is punctuation all the
  // way down. Hashing with an empty key produces a real-looking signature
  // that can never match.
  return keys.filter((k) => k.length > 0);
}

/**
 * The same check as signatureValid, but it says what went wrong.
 *
 * Returns null when the signature is good, and otherwise a sentence naming
 * the reason — safe to print, because none of it is secret material.
 *
 * WHY THIS EXISTS. `signatureValid` returns false for seven distinct
 * reasons: a missing header, a timestamp that is not a number, a timestamp
 * too far out of date, a header in a scheme we do not read, a secret that
 * decodes to nothing, and an actual mismatch. The endpoints logged all seven
 * as "rejected: bad signature", so the one thing the log existed to tell you
 * — whether to go and re-copy the secret, or to look at a clock, or to find
 * out who else is posting to this URL — was the one thing it left out.
 *
 * Jordan hit exactly that: the call webhook began refusing everything, the
 * log said "bad signature", he re-copied the secret and verified it, and the
 * message could not tell him that the secret was never the problem. It is the
 * same mistake as the 200 the texts endpoint used to return for call events,
 * one layer up, and it has the same cure: a refusal has to name itself.
 */
export function signatureProblem({
  id,
  timestamp,
  body,
  header,
  legacy,
  secret,
  now = Date.now(),
}) {
  // `secret` may be one secret or several — see quoSecrets() below.
  if (!secret) return "no signing secret is set in Netlify";

  const sig = parseSignature({ id, timestamp, header, legacy });
  if (!sig) {
    // Nothing we recognise. Which headers DID arrive is the whole diagnosis:
    // none at all means this was not Quo, and one present but unreadable
    // means a scheme change or a proxy rewriting it. The signature values
    // themselves are not printed — a valid signature over a known body is
    // worth something to whoever captured it.
    const present = [
      id && "webhook-id",
      timestamp && "webhook-timestamp",
      header && `webhook-signature (begins "${String(header).slice(0, 8)}")`,
      legacy && `openphone-signature (begins "${String(legacy).slice(0, 8)}")`,
    ].filter(Boolean);

    return present.length
      ? `no signature this code can read; headers present: ${present.join(", ")}`
      : "no signature headers at all — this request did not come from Quo";
  }

  // Standard Webhooks signs the id along with the body, so without it the
  // signed string is "undefined.<ts>.<body>" and nothing can match. Named
  // separately from a missing signature because one header going astray
  // means something in front of the function stripped it, which is a
  // different problem from an unsigned request.
  if (sig.needsId && !id) return "no webhook-id header, but a v1 signature that needs it";

  // Replay guard, before any cryptography.
  const ts = secondsFrom(sig.timestamp);
  if (ts === null) return `the signature timestamp is not a number: ${sig.timestamp}`;
  const skew = Math.round(now / 1000 - ts);
  if (Math.abs(skew) > TOLERANCE_SECONDS) {
    // The number matters: a few seconds over is a slow retry, an hour is a
    // clock, and a day is somebody replaying a captured request.
    return (
      `the signature timestamp is ${skew}s away from now, outside the ` +
      `${TOLERANCE_SECONDS}s tolerance`
    );
  }

  // SEVERAL SECRETS, not one, and this is why.
  //
  // Quo issues a separate signing secret per webhook SUBSCRIPTION. Sky Blue
  // needs two — one carrying messages, one carrying calls — so there are two
  // secrets, and which one arrives depends on which subscription fired. A
  // single-secret verifier means every event from the other subscription is
  // a 403: the endpoint is live, the config looks right, and nothing works.
  // That is a miserable afternoon, and it is also exactly what rotating a
  // secret looks like, where the old and the new are both valid for a while.
  //
  // So the value may hold several, separated by commas or whitespace. Any
  // one of them matching is a pass. Paste both into QUO_WEBHOOK_SECRET and
  // there is nothing left to get wrong.
  // Split on commas AND whitespace, then drop the empties. That one line
  // is the whole parser: a leading separator makes an empty first element
  // and filter(Boolean) removes it, so no trim() is needed — and an empty
  // value yields an empty list, whose loop below runs zero times and falls
  // through to the mismatch message.
  //
  // Both of those were written out explicitly at first — a .trim() and an
  // `if (secrets.length === 0) return false` — and mutation testing showed
  // neither could fail on its own. A condition that cannot fail is one
  // nobody can reason about later, so they went.
  const secrets = String(secret).split(/[\s,]+/).filter(Boolean);
  const keys = secrets.flatMap(keysFor);

  if (keys.length === 0) {
    return `none of the ${secrets.length} configured secret(s) decoded to a usable key`;
  }

  for (const key of keys) {
    const expected = crypto
      .createHmac("sha256", key)
      .update(sig.signed(body), "utf8")
      .digest("base64");

    for (const value of sig.values) {
      const a = Buffer.from(expected);
      const b = Buffer.from(value);
      // Length-checked first: timingSafeEqual throws on a mismatch, and an
      // attacker sending one character would otherwise 500 the endpoint —
      // which Quo treats as retryable and hammers.
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return null;
    }
  }

  // The one that means "the secret in Netlify is not the secret Quo signed
  // with" — after both encodings of every configured secret have been tried.
  //
  // The scheme and the key lengths are the useful details and they give
  // nothing away: a Standard Webhooks secret decodes to 24 bytes, so "7
  // bytes" is somebody who pasted the webhook's name, and a stray character
  // on the end of a paste shows up as a length nobody expects.
  return (
    `${sig.scheme}: the signature did not match any of the ` +
    `${secrets.length} configured secret(s) (key lengths tried: ` +
    `${keys.map((k) => k.length).join(", ")} bytes)` +
    (secrets.some((s) => /["']/.test(s))
      ? " — and one of them contains a quote character, which Netlify stores literally"
      : "")
  );
}

/**
 * Every Quo signing secret this deployment knows about, as one value.
 *
 * BOTH, not one or the other. This was `QUO_CALL_WEBHOOK_SECRET ||
 * QUO_WEBHOOK_SECRET`, and the `||` is a trap now that the verifier accepts a
 * list: setting the call-specific variable to the wrong value meant the
 * working SMS secret was never even tried, so adding a variable in order to
 * fix a 403 could only ever keep it. There is no reason to choose. Quo issues
 * one secret per subscription, any of them is legitimate at either endpoint
 * now that both handle both kinds of event, and trying both costs one HMAC.
 *
 * It also makes rotation a non-event: paste the new secret alongside the old
 * one, redeploy, retire the old one whenever.
 */
export function quoSecrets(env = process.env) {
  return [env.QUO_WEBHOOK_SECRET, env.QUO_CALL_WEBHOOK_SECRET]
    .filter(Boolean)
    .join(",");
}

/**
 * Pull the signature headers off a request.
 *
 * Case-insensitive because Headers is, and named here so a caller cannot
 * quietly misspell one and get an undefined that reads as "unsigned".
 */
export function webhookHeaders(req) {
  const get = (name) => req.headers.get(name);
  return {
    id: get("webhook-id") || get("svix-id"),
    timestamp: get("webhook-timestamp") || get("svix-timestamp"),
    header: get("webhook-signature") || get("svix-signature"),
    // The older scheme, which carries its own timestamp inside the value.
    legacy: get("openphone-signature") || get("quo-signature"),
  };
}
