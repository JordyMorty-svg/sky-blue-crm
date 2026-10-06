// The webhook half of call tracking: node verify/quo-calls.mjs
//
// db/call-tracking.sql decides what a call MEANS and verify/call-tracking.sql
// proves that against a real Postgres. This file is about the other half:
// does the endpoint read Quo's payload correctly, and does it refuse the
// things it must refuse?
//
// THE DANGEROUS DIRECTION HERE IS INVENTION. Everything this endpoint
// records is a statement that somebody had a phone conversation with a
// customer — which is the fact the CRM is least able to check and most
// likely to act on. A parser that reads the wrong participant files the
// call against the wrong person; one that guesses a number files it against
// a stranger; and an endpoint that skips the signature lets anyone who
// learns the URL invent a call history.

import { readCall, customerNumber, isCallCompleted } from "../netlify/functions/quo-calls.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// The payload as Quo's own documentation shows it. Copied rather than
// paraphrased: this is the one shape in the system owned by somebody else,
// and a test written against a tidied-up version of it proves nothing about
// the real one.
const DOCUMENTED = {
  type: "call.completed",
  data: {
    resource: {
      id: "AC-call",
      direction: "incoming",
      status: "answered",
      createdAt: "2026-04-13T11:59:55.000Z",
      answeredAt: "2026-04-13T12:00:00.000Z",
      completedAt: "2026-04-13T12:00:55.000Z",
      updatedAt: "2026-04-13T12:00:55.000Z",
      duration: 55,
      hasVoicemail: false,
    },
    context: {
      orgId: "OR123",
      phoneNumberId: "PN123",
      conversationId: "CN123",
      phoneNumberType: "shared",
      userId: "US123",
      contacts: { ids: ["CT123"], lookupStatus: "matched" },
      participants: {
        workspace: ["+15550000001"],
        external: ["+15550000002"],
        resolution: "available",
      },
    },
  },
};

console.log("\n-- the payload Quo documents --\n");

{
  const evt = readCall(DOCUMENTED);

  // data.RESOURCE, not data.object. The message events use `object` and the
  // call events use `resource`, so a parser that knows only the shape
  // sms-inbound.mjs reads would find nothing here at all — and "nothing"
  // from this endpoint is silence, not an error.
  chk("THE POINT: the call is read from data.resource, not data.object",
    evt.id === "AC-call" && evt.status === "answered",
    JSON.stringify({ id: evt.id, status: evt.status }));

  chk("...the direction", evt.direction === "incoming");
  chk("...the duration, as a number", evt.duration === 55);

  // AS A NUMBER, and that is the point of converting it rather than passing
  // it on. A duration that arrives as the string "55" fails every numeric
  // comparison downstream, so sb_call_connected() reads a four-minute
  // conversation as a call nobody answered — and the lead sits on New
  // while the history says "Called, no answer". Quo sends a number today;
  // nothing in the payload guarantees it always will.
  const asString = readCall({
    type: "call.completed",
    data: { resource: { id: "AC-str", direction: "outgoing", status: "answered", duration: "55" } },
  });
  chk("THE POINT: a duration that arrives as a string is still a number",
    asString.duration === 55,
    `${JSON.stringify(asString.duration)} — a string fails every numeric test ` +
      `downstream and a real conversation reads as "no answer"`);

  chk("...and an absent one is null rather than zero",
    readCall({ data: { resource: { id: "x", status: "answered" } } }).duration === null,
    "zero would be a claim about how long the call lasted that nobody made");

  chk("...and nonsense is null rather than NaN",
    readCall({ data: { resource: { id: "x", duration: "about a minute" } } }).duration === null);
  chk("THE POINT: the customer is the EXTERNAL participant, not the workspace one",
    evt.phone === "+15550000002",
    `${evt.phone} — the workspace number is ours, and filing a call against ` +
      `our own number puts it on nobody's history`);

  // completedAt, not createdAt. The two are a minute apart here and much
  // further apart on a long call; a timeline entry is about the call, and
  // the call is over at completedAt.
  chk("...stamped with when the call ENDED",
    evt.at === "2026-04-13T12:00:55.000Z", evt.at);
}

console.log("\n-- the older shape, which is still live --\n");
//
// OpenPhone became Quo and the payloads moved. Both are accepted rather
// than one: a webhook that stops parsing the day a provider ships a rename
// fails silently, and silence from this endpoint looks exactly like "nobody
// called anybody".

{
  const legacy = {
    type: "call.completed",
    data: {
      object: {
        id: "AC-old",
        direction: "outgoing",
        status: "answered",
        duration: 130,
        to: "+15415550101",
        from: "+15417303593",
        createdAt: "2026-04-13T11:00:00.000Z",
      },
    },
  };
  const evt = readCall(legacy);
  chk("data.object is read too", evt.id === "AC-old" && evt.duration === 130);
  chk("...and the customer is `to` on an outbound call", evt.phone === "+15415550101");

  const inbound = readCall({
    type: "call.completed",
    data: { object: { id: "AC-old2", direction: "incoming", status: "missed", from: "+15415550102" } },
  });
  chk("THE POINT: ...and `from` on an inbound one",
    inbound.phone === "+15415550102",
    `${inbound.phone} — getting this backwards files every missed call ` +
      `against our own number`);
}

console.log("\n-- when it has to guess --\n");

{
  process.env.QUO_FROM = "+15417303593";

  chk("a flat participant list, minus our own number, leaves the customer",
    customerNumber({ participants: ["+15417303593", "+15415550101"] }) === "+15415550101");

  chk("...in either order",
    customerNumber({ participants: ["+15415550101", "+15417303593"] }) === "+15415550101");

  // THE REFUSAL. Three participants is a conference or a second workspace
  // number, and "the first one that isn't us" is a coin toss that writes a
  // phone call onto a real customer's permanent history.
  chk("THE POINT: it refuses to guess between two strangers",
    customerNumber({ participants: ["+15417303593", "+15415550101", "+15415550102"] }) === null,
    "picking the first would file the call against whichever one Quo listed first");

  chk("nothing to go on means nothing",
    customerNumber({}) === null && customerNumber({ participants: [] }) === null);

  // external[] wins over everything. It is Quo's own answer to this exact
  // question and it does not depend on QUO_FROM being set correctly in
  // Netlify.
  chk("THE POINT: Quo's own answer beats our arithmetic",
    customerNumber(
      { direction: "outgoing", to: "+15555550000", participants: ["+19995550000"] },
      { participants: { external: ["+15415550101"] } }
    ) === "+15415550101");

  // QUO_FROM unset is the normal state of a fresh deploy. Subtracting
  // nothing from two participants leaves two, which is a guess, which is
  // refused.
  delete process.env.QUO_FROM;
  chk("with QUO_FROM unset it refuses rather than guessing",
    customerNumber({ participants: ["+15417303593", "+15415550101"] }) === null);
  process.env.QUO_FROM = "+15417303593";
}

console.log("\n-- which events are ours --\n");

{
  chk("call.completed is", isCallCompleted(readCall(DOCUMENTED)));

  for (const t of ["call.ringing", "call.answered", "call.missed", "call.forwarded",
                   "call.menu.selected"]) {
    chk(`${t} is not — the call is not over`,
      !isCallCompleted(readCall({ type: t, data: { resource: { id: "x", status: "answered" } } })));
  }

  // THE ONES THAT LOOK LIKE IT. Each of these is a completion — of a
  // recording, a summary, a transcript, a voicemail — and none of them
  // carries a call status. A loose /call.*completed/ match would take all
  // four, and each would write a second row for a call already logged.
  for (const t of ["call.recording.completed", "call.summary.completed",
                   "call.transcript.completed", "call.voicemail.completed"]) {
    chk(`THE POINT: ${t} is not a completed call`,
      !isCallCompleted(readCall({ type: t, data: { resource: { id: "x", status: "answered" } } })),
      "it would write a second row for a call already on the timeline");
  }

  chk("a message event is not a call",
    !isCallCompleted(readCall({ type: "message.delivered", data: { object: { id: "m1" } } })));
}

console.log("\n-- the rules that must not break --\n");

{
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("netlify/functions/quo-calls.mjs", "utf8");

  // COMMENTS STRIPPED BEFORE ANY OF THIS IS MATCHED.
  //
  // Not fussiness. The first version of these checks searched the file as
  // written, and two of them passed or failed on prose: "the endpoint does
  // not decide what counts as a call" found the word `answered` inside a
  // comment explaining that it does not, and reported the opposite of the
  // truth. A check that reads the explanation instead of the code is worse
  // than no check, because it is green.
  //
  // The same mistake, in the same session, took the whole <head> off the
  // marketing site: a regex for <title> matched one inside an HTML comment.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  // No secret, no entry. An unsigned public endpoint that writes to a
  // customer's history is somewhere anyone who learns the URL can invent a
  // phone call — and "the secret isn't configured yet" is the state a fresh
  // deploy is in, which is exactly when nobody is watching.
  const noSecret = src.indexOf("if (!secret)");
  const verify = src.indexOf("signatureValid({");
  chk("THE POINT: a missing webhook secret is refused, not waved through",
    noSecret > -1 && noSecret < verify,
    "otherwise a deploy with the variable unset accepts invented calls from anybody");

  chk("...with a 403",
    /if \(!secret\)[\s\S]{0,200}?status: 403/.test(src),
    "a 200 here would have Quo believe the event was handled and never resend it");

  // The signature check must come before anything is believed. Matched on
  // the position of the RPC, not on the presence of the call: a verifier
  // that runs after the write is not a verifier.
  const write = src.indexOf('rpc("record_quo_call"');
  chk("THE POINT: nothing is written before the signature is checked",
    verify > -1 && write > -1 && verify < write);

  // Read as text, sign the text. Parsing first and re-serialising changes
  // the bytes — key order and whitespace both — and every signature fails.
  // indexOf RETURNS -1 WHEN IT FINDS NOTHING, and -1 is less than every
  // position in the file. The first version of this check was
  // `indexOf("await req.text()") < verify`, which was true both when the
  // raw read came first and when it had been deleted outright — so
  // replacing it with JSON.stringify(await req.json()), the exact mistake
  // this line exists to catch, passed.
  const rawRead = src.indexOf("await req.text()");
  chk("THE POINT: the raw body is what gets signed, and it is still read raw",
    rawRead > -1 && rawRead < verify && src.indexOf("JSON.parse(raw)") > verify,
    "re-serialising the JSON first changes the bytes — key order and " +
      "whitespace both — and then every signature fails");

  // Never 5xx at Quo: it retries anything that is not a 2xx, and a retry
  // storm is worse than a lost line of history.
  const handler = src.slice(src.indexOf("export default async (req)"));
  const catchBody = handler.slice(handler.indexOf("} catch"));
  chk("the write is wrapped", /\} catch/.test(handler));
  chk("THE POINT: and its failure is swallowed rather than rethrown",
    !/\bthrow\b/.test(catchBody),
    "a throw here becomes a 5xx at Quo, which retries, which hammers");

  // The endpoint holds no policy about what counts as a call. That lives in
  // record_quo_call(), which can see the table; this file cannot, and a
  // second copy of the rule here would be a second answer to the same
  // question.
  chk("THE POINT: the endpoint does not decide what counts as a call",
    !/\b(answered|unanswered|forwarded|abandoned|connected)\b|duration\s*[><=]=/i.test(
      src.slice(src.indexOf("export default async (req)"))
    ),
    "that judgement belongs in db/call-tracking.sql, next to the data");
}

console.log(bad === 0 ? "\nall ok — only calls that happened, only to the right person\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
