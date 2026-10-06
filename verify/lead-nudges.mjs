// The sending half of the board nudges: node verify/lead-nudges.mjs
//
// db/lead-nudges.sql decides WHO gets a text and which one, and
// verify/lead-nudges.sql proves that against a real Postgres. This file is
// about what happens to the rows it returns: the words, and whether the sweep
// does the right thing with every answer sendSms can give back.
//
// rpc and sendSms are replaced through the module loader and every call is
// recorded, because the questions worth asking are "what landed on that
// phone" and "did one bad row take the batch down".
//
// The checks marked THE POINT are the ones this file exists for.

import { pathToFileURL } from "node:url";
import { register } from "node:module";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

const { nudgeContactedSms, nudgeQuotedSms, nudgeBookedSms, segmentsFor } = await import(
  "../netlify/lib/sms.mjs"
);

console.log("\n-- what lands on the phone --\n");

{
  const all = [
    ["contacted", nudgeContactedSms({ customerName: "Kathy O'Reilly", service: "Residential window washing", sentByName: "Hayden Mortensen" })],
    ["quoted", nudgeQuotedSms({ customerName: "Kathy O'Reilly", amount: 1910, service: "Residential window washing", sentByName: "Jordan Mortensen" })],
    ["booked", nudgeBookedSms({ customerName: "Kathy O'Reilly", startsAt: "2026-10-09T16:00:00Z", sentByName: "Hayden Mortensen" })],
  ];

  for (const [name, body] of all) {
    const seg = segmentsFor(body);
    chk(`${name}: says who it is before it asks for anything`,
      body.indexOf("Sky Blue Cleaning") < 50, body);
    chk(`${name}: carries the opt-out`, /Reply STOP to opt out\./.test(body));
    chk(`${name}: plain GSM-7, not double-priced by a curly quote`,
      seg.encoding === "GSM-7", seg.encoding);
    chk(`${name}: fits in two segments`, seg.segments <= 2,
      `${seg.length} chars, ${seg.segments} segments`);
    chk(`${name}: signed with the first name of whoever moved it`,
      /it's (Hayden|Jordan) with/.test(body), body);
  }

  chk("THE POINT: the quoted text states the price",
    /\$1,910/.test(all[1][1]), all[1][1]);
  chk("THE POINT: the booked text states the day and time",
    /Friday, Oct 9/.test(all[2][1]) && /9:00 AM/.test(all[2][1]),
    `${all[2][1]} — rendered in Oregon time, not UTC`);

  chk("a lead with no service still reads as a sentence",
    !/ about \./.test(nudgeContactedSms({ customerName: "Kathy", service: null })),
    nudgeContactedSms({ customerName: "Kathy", service: null }));
  chk("a lead with no name gets 'there', not 'Hi ,'",
    /^Hi there,/.test(nudgeContactedSms({ customerName: "", service: null })));
  chk("an unsigned nudge falls back to the company, never a guessed name",
    nudgeContactedSms({ customerName: "Kathy", service: null }).includes("it's Sky Blue Cleaning"));
  chk("THE POINT: booked with no time refuses to write anything",
    nudgeBookedSms({ customerName: "Kathy", startsAt: null }) === null,
    "\"you're booked in for null\" is not a text anybody should receive");
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const calls = { rpc: [], sms: [] };
let dueRows = [];
let smsAnswer = { ok: true, id: 1, sid: "quo_1" };
let smsThrowsOn = null;

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec.endsWith("/db.mjs")) return { url: "stub:db", shortCircuit: true };
        if (spec.endsWith("/sms.mjs") && ctx.parentURL?.includes("leadNudges"))
          return { url: "stub:sms", shortCircuit: true };
        return next(spec, ctx);
      }
      export async function load(url, ctx, next) {
        if (url === "stub:db")
          return { format: "module", shortCircuit: true, source:
            'export const rpc = (...a) => globalThis.__rpc(...a);' +
            'export const supabaseHeaders = () => ({});' };
        if (url === "stub:sms")
          return { format: "module", shortCircuit: true, source:
            'export const sendSms = (...a) => globalThis.__sms(...a);' +
            'export * from ' + JSON.stringify(${JSON.stringify(
              pathToFileURL(new URL("../netlify/lib/sms.mjs", import.meta.url).pathname).href
            )}) + ';' };
        return next(url, ctx);
      }
    `),
  import.meta.url
);

globalThis.__rpc = async (fn, args) => {
  calls.rpc.push({ fn, args });
  if (fn === "sms_due_lead_nudges") return dueRows;
  return null;
};
globalThis.__sms = async (args) => {
  calls.sms.push(args);
  if (smsThrowsOn && args.leadId === smsThrowsOn) throw new Error("Quo exploded");
  return smsAnswer;
};

const { runLeadNudges, nudgeBody } = await import("../netlify/lib/leadNudges.mjs");

const reset = () => {
  calls.rpc.length = 0;
  calls.sms.length = 0;
  smsThrowsOn = null;
  smsAnswer = { ok: true, id: 1, sid: "quo_1" };
};

const row = (over = {}) => ({
  out_lead_id: "lead-1",
  out_kind: "nudge_contacted",
  out_name: "Kathy O'Reilly",
  out_phone: "+15415550101",
  out_service: "Residential window washing",
  out_estimate: 400,
  out_appoint_at: null,
  out_sender: "Hayden Mortensen",
  ...over,
});

console.log("\n-- the sweep --\n");

{
  reset();
  dueRows = [row()];
  const out = await runLeadNudges();

  chk("a due lead is texted", calls.sms.length === 1 && out.texted === 1, JSON.stringify(out));
  chk("to the number the database handed back", calls.sms[0]?.phone === "+15415550101");
  chk("THE POINT: as the kind the dedupe key is built from",
    calls.sms[0]?.kind === "nudge_contacted", calls.sms[0]?.kind);
  chk("THE POINT: carrying the lead id, or the database cannot deduplicate it",
    calls.sms[0]?.leadId === "lead-1", String(calls.sms[0]?.leadId));
  chk(
    "THE POINT: not forced past quiet hours",
    !calls.sms[0]?.force,
    "the website acknowledgment forces because it answers somebody who messaged a minute ago; " +
      "this is us starting a conversation after moving a card they cannot see"
  );
}

{
  reset();
  dueRows = [
    row({ out_lead_id: "a", out_kind: "nudge_contacted" }),
    row({ out_lead_id: "b", out_kind: "nudge_quoted", out_estimate: 1910 }),
    row({ out_lead_id: "c", out_kind: "nudge_booked", out_appoint_at: "2026-10-09T16:00:00Z" }),
  ];
  const out = await runLeadNudges();
  chk("all three kinds send", out.texted === 3, JSON.stringify(out));
  chk("each gets its own wording",
    new Set(calls.sms.map((c) => c.body)).size === 3);
}

console.log("\n-- rows it declines to write --\n");

{
  reset();
  dueRows = [row({ out_kind: "nudge_quoted", out_estimate: 0 })];
  const out = await runLeadNudges();
  chk("THE POINT: a quoted nudge with no price sends nothing",
    calls.sms.length === 0 && out.skipped === 1,
    "\"we've got you down at $0\" is worse than staying quiet");

  reset();
  dueRows = [row({ out_kind: "nudge_quoted", out_estimate: null })];
  await runLeadNudges();
  chk("...and a null estimate is the same", calls.sms.length === 0);

  reset();
  dueRows = [row({ out_kind: "nudge_booked", out_appoint_at: null })];
  await runLeadNudges();
  chk("THE POINT: a booked nudge with no appointment sends nothing",
    calls.sms.length === 0,
    "the database already refuses this; the sender is the second lock on the same door");

  reset();
  dueRows = [row({ out_kind: "nudge_invented" })];
  await runLeadNudges();
  chk("a kind this build does not know about is left alone, not guessed at",
    calls.sms.length === 0);
}

console.log("\n-- when things go wrong --\n");

{
  reset();
  dueRows = [row({ out_lead_id: "a" }), row({ out_lead_id: "b" }), row({ out_lead_id: "c" })];
  smsThrowsOn = "b";
  const out = await runLeadNudges();
  chk("THE POINT: one row throwing does not abandon the rest of the batch",
    out.texted === 2 && out.problems.length === 1, JSON.stringify(out));
  chk("...and the one that failed is named", out.problems[0].lead === "b");

  reset();
  dueRows = [row()];
  smsAnswer = { ok: false, reason: "already_sent" };
  const dup = await runLeadNudges();
  chk("two runs racing is not reported as a fault",
    dup.skipped === 1 && dup.problems.length === 0, JSON.stringify(dup));

  reset();
  dueRows = [row()];
  smsAnswer = { ok: false, reason: "quiet_hours" };
  const quiet = await runLeadNudges();
  chk("a real refusal is reported", quiet.problems.length === 1, JSON.stringify(quiet));

  reset();
  globalThis.__rpc = async () => {
    throw new Error('Could not find the function public.sms_due_lead_nudges');
  };
  const missing = await runLeadNudges();
  chk("THE POINT: the migration not being run yet does not throw",
    missing.texted === 0 && missing.problems.length === 1,
    "this runs inside the acknowledgment sweep — throwing here would take that down too");
  globalThis.__rpc = async (fn) => (fn === "sms_due_lead_nudges" ? dueRows : null);

  reset();
  dueRows = [];
  const empty = await runLeadNudges();
  chk("an empty sweep sends nothing and raises nothing",
    empty.texted === 0 && empty.problems.length === 0);
}

console.log("\n-- the sweep holds no policy of its own --\n");
//
// Everything about WHO gets a text lives in sms_due_lead_nudges(). If any of
// it leaks into JavaScript there are two answers to the same question, and
// the one that runs is whichever the sweep happens to consult.

{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/lib/leadNudges.mjs", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const [what, re] of [
    ["the 15 minute delay", /15|fifteen|minute/i],
    ["the quiet period", /quiet|hours?\b/i],
    ["the go-live date", /2026|go_?live/i],
    ["which statuses qualify", /'contacted'|'quoted'|'booked'/],
    ["whether a quote was sent", /sent_at|quotes/i],
  ]) {
    chk(`THE POINT: ${what} is not duplicated in the sender`, !re.test(code),
      "it belongs in db/lead-nudges.sql, re-checked at send time");
  }
}

console.log(bad === 0 ? "\nall ok — the board nudges send the right words to the right people\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
