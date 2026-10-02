// Assertions for the sending half of the review request: node verify/follow-up-sms.mjs
//
// db/follow-ups.sql decides WHO gets asked and by which route, and
// verify/follow-ups.sql proves that against a real Postgres. This file is
// about what happens after the row is claimed: the words of the text, and
// whether the sender does the right thing with each answer it can get back.
//
// Nothing here talks to Supabase, Quo or Resend. rpc, sendSms and sendEmail
// are replaced, and the calls they would have made are recorded — because the
// questions worth asking are "what was sent to that number" and "was the row
// put back or burned", and both are visible in those calls.
//
// The checks marked THE POINT are the reasons this file exists.

import { strict as assert } from "node:assert";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

const { reviewSms, segmentsFor } = await import("../netlify/lib/sms.mjs");

const LINK = "https://maps.google.com/?cid=2356952926519109952";

{
  const body = reviewSms({ customerName: "Jordan Mortensen", reviewUrl: LINK });

  chk("it greets them by first name only", /^Hi Jordan,/.test(body), body);
  chk("THE POINT: it says who it is before it asks for anything",
    body.indexOf("Sky Blue Cleaning") < body.indexOf("review"),
    "an unknown number asking for a Google review is what the scam looks like");
  chk("it carries the review link", body.includes(LINK));
  chk("THE POINT: it carries the opt-out", /Reply STOP to opt out\./.test(body),
    "an automatic text without one is the illegal version");

  const seg = segmentsFor(body);
  chk("it is plain GSM-7, not a message that costs double for a curly quote",
    seg.encoding === "GSM-7", seg.encoding);
  chk("THE POINT: it fits in two segments", seg.segments <= 2,
    `${seg.length} chars, ${seg.segments} segments`);

  const signed = reviewSms({
    customerName: "Dana",
    reviewUrl: LINK,
    sentByName: "Hayden Mortensen",
  });
  chk("a named sender signs it with their first name",
    signed.includes("it's Hayden with Sky Blue Cleaning"), signed);
  chk("...and the automatic one signs as the company, never a guessed name",
    body.includes("it's Sky Blue Cleaning") && !/Jordan with/.test(body));

  const nameless = reviewSms({ customerName: "", reviewUrl: LINK });
  chk("a customer with no name on file still gets a sentence, not 'Hi ,'",
    /^Hi there,/.test(nameless), nameless);

  const seg2 = segmentsFor(reviewSms({ customerName: "Bartholomew", reviewUrl: LINK }));
  chk("...and a long name does not push it to three segments", seg2.segments <= 2,
    `${seg2.segments} segments`);
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------
//
// followUps.mjs imports rpc from db.mjs, sendSms from sms.mjs and sendEmail
// from email.mjs. Those three are the whole outside world as far as it is
// concerned, so they are stubbed through the module loader and every call is
// recorded.

const calls = { rpc: [], sms: [], email: [] };
let smsAnswer = { ok: true, id: 1, sid: "quo_1" };
let claimRows = [];

const { register } = await import("node:module");
const { pathToFileURL } = await import("node:url");

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec.endsWith("/db.mjs")) return { url: "stub:db", shortCircuit: true };
        if (spec.endsWith("/sms.mjs") && ctx.parentURL?.includes("followUps"))
          return { url: "stub:sms", shortCircuit: true };
        if (spec.endsWith("/email.mjs")) return { url: "stub:email", shortCircuit: true };
        return next(spec, ctx);
      }
      export async function load(url, ctx, next) {
        if (url === "stub:db")
          return { format: "module", shortCircuit: true, source:
            'export const rpc = (...a) => globalThis.__sbRpc(...a);' +
            'export const supabaseHeaders = () => ({});' };
        if (url === "stub:sms")
          return { format: "module", shortCircuit: true, source:
            'export const sendSms = (...a) => globalThis.__sbSms(...a);' +
            'export { reviewSms } from ' + JSON.stringify(${JSON.stringify(
              pathToFileURL(new URL("../netlify/lib/sms.mjs", import.meta.url).pathname).href
            )}) + ';' };
        if (url === "stub:email")
          return { format: "module", shortCircuit: true, source:
            'export const sendEmail = (...a) => globalThis.__sbEmail(...a);' };
        return next(url, ctx);
      }
    `),
  import.meta.url
);

globalThis.__sbRpc = async (fn, args) => {
  calls.rpc.push({ fn, args });
  if (fn === "claim_follow_ups" || fn === "claim_manual_follow_up") return claimRows;
  if (fn === "sweep_follow_ups") return 0;
  if (fn === "preview_follow_ups") return claimRows;
  return null;
};
globalThis.__sbSms = async (args) => {
  calls.sms.push(args);
  return smsAnswer;
};
globalThis.__sbEmail = async (args) => {
  calls.email.push(args);
  return { ok: true, id: "resend_1" };
};

const { runFollowUps } = await import("../netlify/lib/followUps.mjs");

const reset = () => {
  calls.rpc.length = 0;
  calls.sms.length = 0;
  calls.email.length = 0;
};

const smsRow = (over = {}) => ({
  follow_up_id: 7,
  job_id: "job-1",
  customer_id: "cust-1",
  customer_name: "Phil Phone",
  channel: "sms",
  email: null,
  phone: "+15415550102",
  services: "Gutter cleaning",
  job_date: "2026-09-28T17:00:00Z",
  ...over,
});

const emailRow = (over = {}) => ({
  ...smsRow(),
  follow_up_id: 8,
  customer_id: "cust-2",
  customer_name: "Emma Email",
  channel: "email",
  email: "emma@example.com",
  phone: null,
  ...over,
});

const marked = (fn) => calls.rpc.filter((c) => c.fn === fn).map((c) => c.args);

// --- a text goes out --------------------------------------------------------

{
  reset();
  claimRows = [smsRow()];
  smsAnswer = { ok: true, id: 11, sid: "quo_abc" };

  const out = await runFollowUps({ mode: "send" });

  chk("THE POINT: an sms row is texted, not emailed",
    calls.sms.length === 1 && calls.email.length === 0,
    `${calls.sms.length} texts, ${calls.email.length} emails`);
  chk("to the number the database handed back, in E.164",
    calls.sms[0]?.phone === "+15415550102", calls.sms[0]?.phone);
  chk("as kind 'review', which is what the dedupe key keys on",
    calls.sms[0]?.kind === "review", calls.sms[0]?.kind);
  chk("THE POINT: carrying the job id, or the database cannot deduplicate it",
    calls.sms[0]?.jobId === "job-1", String(calls.sms[0]?.jobId));
  chk("and the customer id, so it lands on their timeline",
    calls.sms[0]?.customerId === "cust-1");
  chk(
    "THE POINT: not forced past quiet hours — nobody is waiting for this one",
    !calls.sms[0]?.force,
    "the acknowledgment text forces because it answers somebody who just messaged us; this does not"
  );

  // The body as the SENDER built it, not as this file built it above. That
  // check used a link typed into the test; this one uses whatever
  // reviewUrlSms() actually returns, which is the thing that decides the
  // bill. Swapping in the 230-character email URL would make every review
  // text three segments and nothing else would have noticed.
  const seg = segmentsFor(calls.sms[0]?.body ?? "");
  chk("THE POINT: the text the sender actually builds fits in two segments",
    seg.segments <= 2, `${seg.length} chars, ${seg.segments} segments`);
  chk("...and it is a link, not a paragraph of one",
    (calls.sms[0]?.body?.match(/https?:\/\/\S+/)?.[0]?.length ?? 999) <= 60,
    calls.sms[0]?.body?.match(/https?:\/\/\S+/)?.[0]);

  const sent = marked("mark_follow_up_sent")[0];
  chk("the row is marked sent with the Quo id", sent?.p_provider_id === "quo_abc");
  chk("THE POINT: recorded as sent to the NUMBER, not a blank email column",
    sent?.p_email === "+15415550102", String(sent?.p_email));
  chk("THE POINT: and told it was a text, so no second history row is written",
    sent?.p_channel === "sms", String(sent?.p_channel));
  chk("the run reports it", out.sent === 1 && out.failed === 0, JSON.stringify(out));
}

// --- an email still goes out ------------------------------------------------

{
  reset();
  claimRows = [emailRow()];

  await runFollowUps({ mode: "send" });

  chk("an email row is still emailed",
    calls.email.length === 1 && calls.sms.length === 0);
  chk("and marked as an email", marked("mark_follow_up_sent")[0]?.p_channel === "email");
  chk("to the address, not a number", marked("mark_follow_up_sent")[0]?.p_email === "emma@example.com");
}

// --- the database decides, not the sender -----------------------------------
//
// A contract test, and worth saying so. claim_follow_ups returns `channel`
// AND both columns, and the sender is supposed to read the channel and
// nothing else — the comment above sendOne says it does not get a vote.
//
// "Text them when there's no email address" happens to be the rule TODAY, so
// a sender that checked `if (!row.email)` would agree with the database on
// every row that currently exists, and quietly stop agreeing the moment the
// rule gains an exception. These two rows are the ones where the shortcut
// and the contract differ.

{
  reset();
  claimRows = [smsRow({ email: "has-both@example.com" })];

  await runFollowUps({ mode: "send" });
  chk("THE POINT: channel 'sms' is texted even though the row carries an email",
    calls.sms.length === 1 && calls.email.length === 0,
    "the sender read the email column instead of the channel the database chose");
}

{
  reset();
  claimRows = [emailRow({ phone: "+15415550102" })];

  await runFollowUps({ mode: "send" });
  chk("...and channel 'email' is emailed even though we have their number",
    calls.email.length === 1 && calls.sms.length === 0);
}

// --- a mixed batch ----------------------------------------------------------

{
  reset();
  claimRows = [smsRow(), emailRow()];

  const out = await runFollowUps({ mode: "send" });

  chk("a batch of both goes out both ways",
    calls.sms.length === 1 && calls.email.length === 1 && out.sent === 2,
    JSON.stringify(out));
}

// --- "not now" is not a failure ---------------------------------------------

for (const reason of ["sms_off", "preview", "not_configured", "no_sms_tables", "quiet_hours"]) {
  reset();
  claimRows = [smsRow()];
  smsAnswer = { ok: false, reason };

  const out = await runFollowUps({ mode: "send" });

  const deferred = marked("mark_follow_up_deferred");
  const failed = marked("mark_follow_up_failed");

  chk(`THE POINT: "${reason}" defers the row instead of spending an attempt`,
    deferred.length === 1 && failed.length === 0,
    `${deferred.length} deferred, ${failed.length} failed — three of these in a row would skip the customer forever`);
  chk(`...and the run says so rather than claiming success`,
    out.deferred === 1 && out.sent === 0, JSON.stringify(out));
}

// --- a real refusal IS a failure --------------------------------------------

{
  reset();
  claimRows = [smsRow()];
  smsAnswer = { ok: false, reason: "opted_out" };

  const out = await runFollowUps({ mode: "send" });

  chk("THE POINT: a refusal from the customer is a failure, not a deferral",
    marked("mark_follow_up_failed").length === 1 &&
      marked("mark_follow_up_deferred").length === 0,
    "deferring it forever would retry a STOP reply every morning until the window closed");
  chk("and the reason is kept", marked("mark_follow_up_failed")[0]?.p_error === "opted_out");
  chk("the run counts it as failed", out.failed === 1, JSON.stringify(out));
}

{
  reset();
  claimRows = [smsRow()];
  smsAnswer = { ok: false, reason: "bad_number" };

  await runFollowUps({ mode: "send" });
  chk("an unusable number is a failure too, and says which",
    marked("mark_follow_up_failed")[0]?.p_error === "bad_number");
}

// --- one bad one does not take the batch down -------------------------------

{
  reset();
  claimRows = [smsRow(), emailRow(), smsRow({ follow_up_id: 9, customer_id: "cust-3" })];
  let n = 0;
  globalThis.__sbSms = async (args) => {
    calls.sms.push(args);
    n += 1;
    if (n === 1) throw new Error("Quo exploded");
    return { ok: true, id: 1, sid: "quo_z" };
  };

  const out = await runFollowUps({ mode: "send" });

  chk("THE POINT: one text throwing does not abandon the rest of the batch",
    out.sent === 2 && out.failed === 1, JSON.stringify(out));
  chk("and the one that threw is released rather than left claimed",
    marked("mark_follow_up_failed").length === 1);

  globalThis.__sbSms = async (args) => {
    calls.sms.push(args);
    return smsAnswer;
  };
}

// --- the preview tells the truth --------------------------------------------

{
  reset();
  claimRows = [
    { follow_up_id: 7, customer_name: "Phil Phone", channel: "sms",
      email: null, phone: "+15415550102", due_at: "2026-10-01T07:00:00Z" },
    { follow_up_id: 8, customer_name: "Emma Email", channel: "email",
      email: "emma@example.com", phone: null, due_at: "2026-10-01T07:00:00Z" },
  ];

  const out = await runFollowUps({ mode: "preview" });

  chk("a preview sends nothing at all",
    calls.sms.length === 0 && calls.email.length === 0);
  chk("THE POINT: and shows the number for a text, not an empty email column",
    out.would_send[0].to === "+15415550102" && out.would_send[0].via === "sms",
    JSON.stringify(out.would_send[0]));
  chk("...and the address for an email",
    out.would_send[1].to === "emma@example.com" && out.would_send[1].via === "email");
  chk("and nothing was claimed, so flipping to send still sends them",
    marked("claim_follow_ups").length === 0);
}

// --- off means off ----------------------------------------------------------

{
  reset();
  claimRows = [smsRow()];

  const out = await runFollowUps({ mode: "off" });
  chk("THE POINT: FOLLOW_UPS_MODE=off texts nobody either",
    calls.sms.length === 0 && calls.rpc.length === 0, JSON.stringify(out));
}

// ---------------------------------------------------------------------------

assert(typeof runFollowUps === "function");
console.log(bad === 0 ? "\nall ok — the review request goes the right way\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
