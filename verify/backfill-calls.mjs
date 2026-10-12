// Importing call history out of Quo:
//   node verify/backfill-calls.mjs
//
// WHAT THIS FILE IS ABOUT. record_quo_call() used to drop every call to a
// number nobody in the CRM owned, so every call made before somebody was
// entered as a lead was thrown away at the webhook. Quo still has them.
// This endpoint reads them back.
//
// The risk is not the HTTP. It is that this becomes a SECOND PARSER of
// Quo's call shape, drifting from the one the live webhook uses. The
// webhook's readCall() knows two things that are easy to miss and invisible
// when you miss them:
//
//   a duration that arrives as the STRING "55", which compares false
//   against every numeric threshold
//
//   a duration that is MISSING, which the live webhook does on every single
//   call, and has to be derived from answeredAt and completedAt
//
// Get either wrong and a real seventeen-second conversation imports as "No
// answer", on the right person's page, with no error anywhere. So most of
// this file is about asCall() being readCall() and not a paraphrase of it.
//
// Checks marked THE POINT are the ones this file exists for.

import { readFileSync } from "node:fs";
import { asCall, fetchCallPage } from "../netlify/functions/backfill-calls.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// COMMENTS OUT BEFORE ANY SOURCE-TEXT ASSERTION. Seventh time in this repo.
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const THEM = "+15415559876";

console.log("\n-- a call from the API, as the database wants it --\n");

{
  const row = asCall(
    {
      id: "AC123",
      direction: "outgoing",
      status: "completed",
      duration: 95,
      answeredAt: "2026-10-08T15:00:00.000Z",
      completedAt: "2026-10-08T15:01:35.000Z",
      participants: ["+15035550000", THEM],
    },
    THEM
  );

  chk("every argument record_quo_call takes is present",
    ["p_call_id", "p_phone", "p_direction", "p_status", "p_duration", "p_at", "p_answered"]
      .every((k) => k in row),
    "a missing key is a Postgres default silently standing in for a fact " +
      "Quo actually sent");

  chk("the id, direction and status come across",
    row.p_call_id === "AC123" &&
      row.p_direction === "outgoing" &&
      row.p_status === "completed");

  chk("THE POINT: the phone is the one we ASKED for",
    row.p_phone === THEM,
    "not whichever participant the payload happens to list first. We queried " +
      "Quo by this number, so it is the one fact in the response we already " +
      "know for certain — deriving it again is a chance to import a call " +
      "onto the wrong person");

  chk("the timestamp is when the call ENDED, not when we imported it",
    row.p_at === "2026-10-08T15:01:35.000Z",
    "importing a year of history today must not stamp all of it today");
}

console.log("\n-- the two duration traps --\n");

{
  // THE STRING. Quo has sent these.
  const asString = asCall(
    { id: "a", direction: "outgoing", status: "completed", duration: "55" },
    THEM
  );
  chk('THE POINT: a duration of "55" arrives as the number 55',
    asString.p_duration === 55,
    "a string compares false against every numeric threshold, so " +
      "sb_call_connected says nobody picked up and a 55-second conversation " +
      "imports as 'No answer'");

  // THE MISSING ONE. This is what the live webhook sends every time, so it
  // is also what most of the history in Quo looks like.
  const derived = asCall(
    {
      id: "b",
      direction: "outgoing",
      status: "completed",
      answeredAt: "2026-10-08T15:00:00.000Z",
      completedAt: "2026-10-08T15:00:17.000Z",
    },
    THEM
  );
  chk("THE POINT: a missing duration is derived from the two timestamps",
    derived.p_duration === 17,
    "17 seconds, from answeredAt to completedAt. Without this the whole " +
      "backlog imports as attempts rather than conversations");

  const fractional = asCall(
    { id: "c", direction: "outgoing", status: "completed", duration: 6.55675 },
    THEM
  );
  chk("a fractional duration is rounded",
    fractional.p_duration === 7,
    "duration_seconds is an integer column and Postgres rejects 6.55675 — " +
      "it took a transcript import down once already");

  const none = asCall({ id: "d", direction: "outgoing", status: "no-answer" }, THEM);
  chk("a call with no duration and nothing to derive from stays null",
    none.p_duration === null,
    "null, not 0: zero is a fact about a call that connected");
}

console.log("\n-- answered is three states, not two --\n");

{
  chk("THE POINT: a MISSING answeredAt field is null, not false",
    asCall({ id: "e", direction: "outgoing", status: "answered" }, THEM).p_answered === null,
    "null means 'the payload did not say' and lets the status word decide. " +
      "false means Quo said nobody picked up. Folding them together marks " +
      "every older payload shape as unanswered and buries the real calls");

  chk("a present-but-null answeredAt is false",
    asCall(
      { id: "f", direction: "outgoing", status: "completed", answeredAt: null },
      THEM
    ).p_answered === false);

  chk("a real answeredAt is true",
    asCall(
      { id: "g", direction: "outgoing", status: "completed", answeredAt: "2026-10-08T15:00:00Z" },
      THEM
    ).p_answered === true);
}

console.log("\n-- the parser is the webhook's, not a copy --\n");

{
  const src = strip(readFileSync("netlify/functions/backfill-calls.mjs", "utf8"));

  chk("THE POINT: asCall calls readCall from the webhook",
    /import \{ readCall \} from "\.\/quo-calls\.mjs"/.test(src) && /readCall\(call\)/.test(src),
    "everything above this line is really a test of readCall. A second " +
      "parser here would pass these same checks on the day it was written " +
      "and drift the first time Quo changes a field name");

  chk("...and does not re-derive any of it",
    !/answeredAt/.test(src) && !/completedAt/.test(src) && !/durationSeconds/.test(src),
    "naming those fields here is the start of the second parser");

  chk("the page helper reuses the text backfill's number lookup",
    /import \{ ourNumberId \} from "\.\/backfill-texts\.mjs"/.test(src),
    "which Quo number is ours is one question with one answer");
}

console.log("\n-- what the endpoint does with a page --\n");

{
  const src = strip(readFileSync("netlify/functions/backfill-calls.mjs", "utf8"));

  chk("THE POINT: each call goes through record_quo_call",
    /rpc\("record_quo_call", args\)/.test(src),
    "the same function the live webhook calls, so an imported call gets the " +
      "same gate on whether it happened, the same four kinds, the same " +
      "wording and the same orphan branch. A bulk import function would be " +
      "a second implementation of all four");

  chk("a call with no id is skipped before the round trip",
    /if \(!args\.p_call_id\) continue;/.test(src),
    "record_quo_call refuses it anyway; this saves being told so a hundred " +
      "times");

  chk("only rows that were actually written are counted",
    /if \(id\) imported \+= 1;/.test(src),
    "record_quo_call returns null for a repeat and for a call that never " +
      "happened — counting those would report 40 imported on a second press " +
      "that changed nothing");

  chk("the page ceiling is there",
    /pages < MAX_PAGES/.test(src),
    "Netlify gives the function ten seconds");

  // ONE VARIABLE, AND BOTH SITES MUST BE THE BARE NAME. Asserting only that
  // `const more = ...` appears once lets a mutant write `more: Boolean(null)`
  // into the log and survive — which is exactly the bug the single variable
  // exists to prevent, so a check that misses it is worse than none.
  chk("`more` is computed once and read twice",
    (src.match(/const more = Boolean\(token\)/g) || []).length === 1 &&
      /\n\s+more,\n\s*\}\);/.test(src) &&
      /ok: true, scanned, imported, more \}/.test(src),
    "written out twice, a mutation run changed only the copy in the log: " +
      "the response stayed correct, every test passed, and the log quietly " +
      "started reporting finished imports that were not");

  chk("it refuses anybody not signed in",
    /whoIs\(req\)/.test(src) && /status: 401/.test(src));

  chk("a failure comes back as a sentence, not a 500",
    /ok: false, error: err\?\.message/.test(src),
    "the browser shows this to whoever pressed the button; a 500 shows them " +
      "a blank failure with the reason in a log they cannot read");
}

console.log("\n-- the request it sends --\n");

{
  let seen = null;
  const fakeFetch = async (url) => {
    seen = new URL(url);
    return { ok: true, status: 200, json: async () => ({ data: [], nextPageToken: null }) };
  };

  await fetchCallPage({
    phoneNumberId: "PN1",
    participant: THEM,
    pageToken: null,
    fetchImpl: fakeFetch,
  });

  chk("THE POINT: it asks the calls endpoint, not messages",
    seen.pathname.endsWith("/calls"),
    "/messages with a call parser would return texts and import none of " +
      "them, reporting a cheerful 'scanned 40, imported 0'");

  chk("...for one participant, on our number",
    seen.searchParams.get("phoneNumberId") === "PN1" &&
      seen.searchParams.getAll("participants[]").join() === THEM,
    "Quo has no 'list every call' — and per-person is the right filter " +
      "anyway, since the only calls worth importing belong to somebody " +
      "already in the CRM");

  chk("no page token on the first request",
    !seen.searchParams.has("pageToken"));

  await fetchCallPage({
    phoneNumberId: "PN1",
    participant: THEM,
    pageToken: "tok2",
    fetchImpl: fakeFetch,
  });
  chk("...and the token on the next one",
    seen.searchParams.get("pageToken") === "tok2",
    "without this every page is page one and the loop imports the same " +
      "hundred calls five times");
}

console.log("\n-- the route --\n");

{
  const src = readFileSync("netlify/functions/backfill-calls.mjs", "utf8");

  chk("THE POINT: the function declares its URL",
    /export const config = \{[\s\S]*?path:\s*"\/api\/backfill-calls"/.test(src),
    "netlify.toml has no redirect rules — a v2 function with no config " +
      "block deploys and has no URL. This file shipped without one: " +
      "/api/backfill-calls returned the SPA's index.html and the page said " +
      "'Couldn't reach Quo.' verify/module-bindings.mjs now checks every " +
      "function in the directory, because the next one to forget will fail " +
      "exactly as quietly");
}

console.log("\n-- a missing endpoint says so --\n");

{
  const src = readFileSync("src/services/contactService.js", "utf8");

  chk("THE POINT: HTML back from the endpoint is not reported as a Quo problem",
    /content-type/.test(src) && /isn't deployed yet/.test(src),
    "'Couldn't reach Quo.' is a sentence about the Quo account. It cost an " +
      "afternoon of looking in the wrong place for a missing three-line " +
      "export");

  chk("...and the same fix is in the text import beside it",
    /isn't deployed yet/.test(readFileSync("src/services/textService.js", "utf8")),
    "the two buttons sit on the same page and had the identical flaw");

  chk("a 401 is still its own message",
    /Sign in again to import from Quo/.test(src),
    "signed out and not deployed are different problems with different " +
      "next steps");
}

console.log("\n-- when Quo says no --\n");

{
  const refuse = (status) => async () => ({
    ok: false,
    status,
    json: async () => ({}),
  });

  let msg = "";
  try {
    await fetchCallPage({ phoneNumberId: "PN1", participant: THEM, fetchImpl: refuse(429) });
  } catch (e) {
    msg = e.message;
  }
  chk("a rate limit says so by name",
    /429/.test(msg) && /rate limit/i.test(msg),
    "the one failure here worth simply retrying, and it should not read as " +
      "a broken key");

  msg = "";
  try {
    await fetchCallPage({ phoneNumberId: "PN1", participant: THEM, fetchImpl: refuse(401) });
  } catch (e) {
    msg = e.message;
  }
  chk("any other refusal carries its status",
    /401/.test(msg),
    "401 is the wrong key, 403 is the wrong scope, and a message that says " +
      "neither sends somebody to the wrong settings page");

  const empty = await fetchCallPage({
    phoneNumberId: "PN1",
    participant: THEM,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  chk("a body with no data array is an empty page, not a crash",
    Array.isArray(empty.rows) && empty.rows.length === 0 && empty.next === null);
}

console.log(bad === 0
  ? "\nall ok — the calls Quo kept and the CRM threw away\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
