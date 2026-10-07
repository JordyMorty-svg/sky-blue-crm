// netlify/functions/backfill-texts.mjs
//
// Pulling a conversation that already happened out of Quo and into the CRM.
//
// WHY THERE IS ANYTHING TO PULL. The thread on a lead or customer page reads
// sms_messages, which holds what the CRM sent plus whatever the inbound
// webhook captured. That webhook rejected every request Quo ever made to it —
// a millisecond timestamp against a seconds-wide replay window, see
// claude/crm-webhook-signature-diagnosis.md — so nothing inbound was ever
// stored. Every bubble in every thread is one the CRM sent. The customer's
// half of each conversation has been sitting in Quo the whole time.
//
// Replies land on their own now. This is for the backlog.
//
// WHAT IT DOES NOT DO. It does not decide anything. Which recorder a message
// belongs in, whether it counts as outreach, whether it is already stored,
// what an empty body means — all of that is import_quo_text() in
// db/sms-backfill.sql, where it can be read in one place and tested against a
// real Postgres. This file reads pages off Quo and hands them over.
//
// Environment — all of them already set, if texting works:
//   QUO_API_KEY                — to read the message history
//   QUO_FROM                   — which of the workspace's numbers is ours
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  — to check who is calling
//   SUPABASE_SERVICE_ROLE_KEY  — to write
// Optional:
//   QUO_PHONE_NUMBER_ID        — skips the lookup below. Only worth setting
//                                if the workspace ever has two numbers.

import { rpc } from "../lib/db.mjs";
import { QUO_BASE, toE164 } from "../lib/sms.mjs";
import { whoIs } from "../lib/whoIs.mjs";

// A hard ceiling on one press of the button.
//
// Netlify gives a function ten seconds by default. Each page is one call to
// Quo and one to Supabase, so five pages is ten round trips and five hundred
// messages — more conversation than Sky Blue has had with anybody. Pressing
// again continues from the top, and because every message deduplicates on its
// Quo id, pressing again is free.
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

function quoHeaders() {
  return {
    // Bare, NOT "Bearer " — Quo's docs are explicit and prefixing it fails
    // with a 401 that looks exactly like a wrong key.
    Authorization: process.env.QUO_API_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * Which Quo number is ours, as the id their API wants.
 *
 * Looked up rather than configured. QUO_FROM is already set — it is the
 * number every text goes out from — and asking for a second environment
 * variable holding the id of the same phone number is one more thing to get
 * wrong on a Tuesday, for no information the system does not already have.
 *
 * QUO_PHONE_NUMBER_ID short-circuits it for the day there are two numbers
 * and a lookup by digits stops being unambiguous.
 */
export async function ourNumberId(fetchImpl = fetch) {
  if (process.env.QUO_PHONE_NUMBER_ID) return process.env.QUO_PHONE_NUMBER_ID;

  const ours = toE164(process.env.QUO_FROM);
  if (!ours) throw new Error("QUO_FROM is not set, or is not a phone number");

  const res = await fetchImpl(`${QUO_BASE()}/phone-numbers`, { headers: quoHeaders() });
  if (!res.ok) {
    throw new Error(`Quo refused the phone-number list (${res.status})`);
  }

  const body = await res.json().catch(() => ({}));
  const rows = Array.isArray(body?.data) ? body.data : [];

  const match = rows.find((r) => toE164(r?.number) === ours);
  if (!match?.id) {
    // Named, because the fix is a one-line change to an environment variable
    // and the alternative is a 404 from a different endpoint entirely.
    throw new Error(
      `QUO_FROM (${ours}) is not one of the ${rows.length} numbers on this Quo workspace`
    );
  }
  return match.id;
}

/**
 * One page of messages between our number and theirs.
 *
 * Quo pages newest-first and hands back a token. No sorting here: the thread
 * query orders by time, and a half-imported conversation is in the right
 * order the moment it loads regardless of what order the rows arrived in.
 */
export async function fetchPage({ phoneNumberId, participant, pageToken, fetchImpl = fetch }) {
  const url = new URL(`${QUO_BASE()}/messages`);
  url.searchParams.set("phoneNumberId", phoneNumberId);
  url.searchParams.append("participants[]", participant);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetchImpl(url.toString(), { headers: quoHeaders() });

  if (res.status === 429) {
    // Quo allows ten requests a second. Named rather than buried, because a
    // rate limit is the one failure here that is worth simply retrying.
    throw new Error("Quo rate limit (429) — try again in a moment");
  }
  if (!res.ok) {
    throw new Error(`Quo refused the message history (${res.status})`);
  }

  const body = await res.json().catch(() => ({}));
  return {
    rows: Array.isArray(body?.data) ? body.data : [],
    next: body?.nextPageToken || null,
  };
}

/**
 * Quo's message shape, as the database wants it.
 *
 * `direction` is 'incoming' or 'outgoing' from the WORKSPACE's point of view,
 * so outgoing is Sky Blue talking. Getting that backwards would file every
 * customer's words as our own and vice versa — the thread would still look
 * plausible, which is what makes it worth a test of its own.
 *
 * The phone recorded is always the CUSTOMER's, in both directions, because
 * that is what sms_messages.phone means and what sms_thread() keys on.
 */
export function asRow(message, participant) {
  const outgoing = /^out/i.test(String(message?.direction || ""));
  return {
    phone: participant,
    body: message?.text ?? message?.body ?? "",
    sid: message?.id || null,
    at: message?.createdAt || message?.sentAt || null,
    outgoing,
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const userId = await whoIs(req);
  if (!userId) {
    return new Response(JSON.stringify({ ok: false, error: "Not signed in." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let input = {};
  try {
    input = await req.json();
  } catch {
    input = {};
  }

  const participant = toE164(input?.phone);
  if (!participant) {
    return new Response(
      JSON.stringify({ ok: false, error: "That doesn't look like a phone number." }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  try {
    const phoneNumberId = await ourNumberId();

    let token = null;
    let scanned = 0;
    let imported = 0;
    let pages = 0;

    do {
      const { rows, next } = await fetchPage({
        phoneNumberId,
        participant,
        pageToken: token,
      });

      scanned += rows.length;

      if (rows.length) {
        const added = await rpc("import_quo_texts", {
          p_rows: rows.map((m) => asRow(m, participant)),
        });
        imported += Number(added) || 0;
      }

      token = next;
      pages += 1;
    } while (token && pages < MAX_PAGES);

    // ONE VARIABLE, READ TWICE. True when Quo still had pages and the
    // ceiling stopped us; the screen uses it to say "press again for older"
    // rather than claiming the conversation is complete.
    //
    // Computed once rather than written out at both sites, and that is not
    // tidiness. Written twice, a mutation run changed only the copy in the
    // log — the response stayed correct, every test passed, and the log
    // quietly started reporting finished imports that were not. One source,
    // and the log cannot disagree with the answer.
    const more = Boolean(token);

    // One line per import, with the number masked the way the rest of this
    // codebase logs numbers.
    console.log("[backfill-texts] imported", {
      who: participant.slice(-4),
      scanned,
      imported,
      pages,
      more,
    });

    return new Response(JSON.stringify({ ok: true, scanned, imported, more }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[backfill-texts] failed", err);
    // 200 with a reason, like send-text.mjs. The browser shows this sentence
    // to whoever pressed the button, and a 500 would show them a blank
    // failure with the reason in a log they cannot read.
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || "Couldn't reach Quo." }),
      { headers: { "content-type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/backfill-texts",
};
