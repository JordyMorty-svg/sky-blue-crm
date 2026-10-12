// netlify/functions/backfill-calls.mjs
//
// Pulling calls that already happened out of Quo and onto somebody's page.
//
// THE TWIN OF backfill-texts.mjs, deliberately: same auth, same paging, same
// ceiling, same shape of response, so the two buttons behave the same way and
// a fix to one is an obvious fix to the other. Read that file first; this one
// only notes where it differs.
//
// WHY THERE IS ANYTHING TO PULL. record_quo_call() dropped every call to a
// number nobody in the CRM owned — see db/orphan-calls.sql for why that was
// right about suppliers and wrong about customers. Every call made before
// somebody was entered as a lead was discarded at the webhook. Quo still has
// them.
//
// Going forward nothing is lost: orphan calls are written against the phone
// and surface when the lead appears. This is for the backlog, and for the
// window between a call arriving and db/orphan-calls.sql being run.
//
// WHAT IT DOES NOT DO. It does not decide anything. Whether a call happened,
// which kind it was, how to word it, whether it is already stored, who it
// belongs to — all of that is record_quo_call() in db/call-outcome.sql and
// db/orphan-calls.sql, which can be read in one place and tested against a
// real Postgres. This file reads pages off Quo and hands them over, one call
// at a time, exactly as the live webhook would have.
//
// Environment — all already set, if calls and texts work:
//   QUO_API_KEY, QUO_FROM
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   — to check who is calling
//   SUPABASE_SERVICE_ROLE_KEY                   — to write
// Optional:
//   QUO_PHONE_NUMBER_ID

import { rpc } from "../lib/db.mjs";
import { QUO_BASE, toE164 } from "../lib/sms.mjs";
import { whoIs } from "../lib/whoIs.mjs";
import { ourNumberId } from "./backfill-texts.mjs";
import { readCall } from "./quo-calls.mjs";

// Same ceiling as the text backfill, and for the same reason: Netlify gives
// a function ten seconds, each page is two round trips, and pressing again
// is free because every call deduplicates on its Quo id.
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

function quoHeaders() {
  return {
    // Bare, NOT "Bearer " — see backfill-texts.mjs.
    Authorization: process.env.QUO_API_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * One page of calls between our number and theirs.
 *
 * /calls takes the same parameters as /messages and, like it, REQUIRES a
 * participant — Quo has no "list everything" call. That constraint turns out
 * to be the right shape for this feature rather than a limitation to work
 * around: the only calls worth importing are the ones belonging to somebody
 * already in the CRM, and asking per-person is exactly that filter.
 */
export async function fetchCallPage({ phoneNumberId, participant, pageToken, fetchImpl = fetch }) {
  const url = new URL(`${QUO_BASE()}/calls`);
  url.searchParams.set("phoneNumberId", phoneNumberId);
  url.searchParams.append("participants[]", participant);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetchImpl(url.toString(), { headers: quoHeaders() });

  if (res.status === 429) {
    throw new Error("Quo rate limit (429) — try again in a moment");
  }
  if (!res.ok) {
    throw new Error(`Quo refused the call history (${res.status})`);
  }

  const body = await res.json().catch(() => ({}));
  return {
    rows: Array.isArray(body?.data) ? body.data : [],
    next: body?.nextPageToken || null,
  };
}

/**
 * A call from the API, in the arguments record_quo_call() takes.
 *
 * THE PARSING IS readCall's, NOT A SECOND COPY. That function already knows
 * every shape Quo has used for a call — `data.resource`, `data.object`, the
 * bare body — and more importantly it knows the two things that are easy to
 * get wrong and invisible when you do: a duration that arrives as a string,
 * and a duration that is missing entirely and has to be derived from
 * answeredAt and completedAt, which is what the live webhook sends every
 * time. Re-deriving any of that here would be a second implementation to
 * keep in step, and the symptom of it drifting is a real conversation
 * importing as "No answer".
 *
 * It takes a whole payload and this is a bare call object, which is already
 * handled: `data.resource || data.object || data` falls through to the
 * object itself.
 *
 * THE PHONE IS OURS, NOT readCall's. It works out which participant is the
 * customer from the payload, and it is good at it, but here we already know
 * — we asked Quo for this person's calls by number. Using the one we asked
 * for means a payload whose participant fields are shaped unexpectedly
 * imports against the right person anyway.
 */
export function asCall(call, participant) {
  const c = readCall(call);
  return {
    p_call_id: c.id,
    p_phone: participant,
    p_direction: c.direction,
    p_status: c.status,
    p_duration: c.duration,
    p_at: c.at,
    // Three states, and `null` is not `false` — see readCall. A missing
    // answeredAt field is "the payload did not say" and lets the status word
    // decide; a present-but-null one is Quo saying nobody picked up.
    p_answered: c.answered,
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
      const { rows, next } = await fetchCallPage({
        phoneNumberId,
        participant,
        pageToken: token,
      });

      scanned += rows.length;

      // ONE CALL PER rpc, where the text backfill sends a page at a time.
      //
      // Not an oversight and not laziness: import_quo_texts() is a bulk
      // function written for that job, and record_quo_call() is the function
      // the live webhook calls. Reusing it means an imported call and a
      // webhook call go down the same path — the same gate on whether the
      // call happened, the same four kinds, the same wording, the same
      // orphan branch, the same dedupe. A bulk variant would be a second
      // implementation of all six, and the first thing it would drift on is
      // the one nobody tests: a call that should not have been written.
      //
      // A hundred round trips in a page is the cost. At Sky Blue's volume
      // the whole history of one customer is one page and usually under ten
      // calls, and correctness is worth more here than a request count.
      for (const row of rows) {
        const args = asCall(row, participant);
        // No id, no dedupe — record_quo_call refuses it anyway, and this
        // saves the round trip to be told so.
        if (!args.p_call_id) continue;
        const id = await rpc("record_quo_call", args);
        if (id) imported += 1;
      }

      token = next;
      pages += 1;
    } while (token && pages < MAX_PAGES);

    // One variable, read twice — see the note in backfill-texts.mjs about
    // the mutation that changed only the copy in the log.
    const more = Boolean(token);

    console.log("[backfill-calls] imported", {
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
    console.error("[backfill-calls] failed", err);
    // 200 with a reason, like backfill-texts.mjs: the browser shows this
    // sentence to whoever pressed the button.
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || "Couldn't reach Quo." }),
      { headers: { "content-type": "application/json" } }
    );
  }
};

/*
 * THE ROUTE, AND THIS FILE SHIPPED WITHOUT IT.
 *
 * netlify.toml declares no redirect rules — "Netlify Functions v2. Each
 * function declares its own route via `export const config = { path:
 * '/api/...' }`". A function with no config block is still deployed and
 * still bundled; it just has no URL. /api/backfill-calls returned the SPA's
 * index.html, the browser failed to parse it as JSON, and the page said
 * "Couldn't reach Quo." — which sent Jordan looking at his Quo account for
 * a problem that was a missing three-line export.
 *
 * verify/module-bindings.mjs now checks every function in this directory
 * for one, because this is a whole-repo invariant and the next file to
 * forget it will fail exactly as quietly.
 */
export const config = {
  path: "/api/backfill-calls",
};
