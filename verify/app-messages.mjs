// The webhook half of keeping app-sent texts: node verify/app-messages.mjs
//
// db/sms-app-messages.sql decides which outbound copies are new and which are
// the CRM's own coming back, and verify/sms-app-messages.sql proves that
// against a real Postgres. This file is about the other half: does the
// webhook actually hand them over, and does it still refuse to treat an
// outbound copy as something the customer said.
//
// That second one is the dangerous direction. Everything downstream of the
// inbound branch treats the event as the customer talking — so an outbound
// copy reaching it would put our own words on the timeline as theirs, and a
// message that happened to read "STOP" would opt a customer out of their own
// conversation.

import { readEvent, isDelivered } from "../netlify/functions/sms-inbound.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

console.log("\n-- reading the recipient off an outbound copy --\n");
//
// `to` is the only field that says whose thread an app-sent message belongs
// on. Quo has already renamed things once (OpenPhone -> Quo), so every shape
// it has plausibly used is accepted rather than one.

{
  const shapes = [
    ["a bare string", { data: { object: { to: "+15415550101", text: "hi", direction: "outgoing" } } }],
    ["an array, because `to` is plural for a group", { data: { object: { to: ["+15415550101"], text: "hi" } } }],
    ["named `recipient`", { data: { object: { recipient: "+15415550101", text: "hi" } } }],
    ["named `recipients`", { data: { object: { recipients: ["+15415550101"], text: "hi" } } }],
  ];
  for (const [name, payload] of shapes) {
    chk(`the recipient is read from ${name}`,
      readEvent(payload).to === "+15415550101", JSON.stringify(readEvent(payload).to));
  }

  chk("an inbound event has no recipient to confuse it with",
    readEvent({ data: { object: { from: "+15415550101", text: "hi" } } }).to == null);

  chk("THE POINT: the sender is still read for inbound, unchanged",
    readEvent({ data: { object: { from: "+15415550102", text: "hello" } } }).from === "+15415550102");
}

console.log("\n-- which events carry an app-sent message --\n");
//
// Quo delivers these as a DELIVERY event, which is why they were being lost:
// the delivery branch stamped delivered_at for messages we sent, matched
// nothing for messages we did not, and returned 200 either way.

{
  const appSent = {
    type: "message.delivered",
    data: { object: { id: "q1", to: "+15415550101", text: "On my way", direction: "outgoing", status: "delivered" } },
  };
  const evt = readEvent(appSent);

  chk("THE POINT: an app-sent message arrives as a delivery event",
    isDelivered(evt),
    "which is exactly why it fell out of that branch and was never recorded");
  chk("...carrying the words", evt.body === "On my way");
  chk("...the recipient", evt.to === "+15415550101");
  chk("...and the provider id the database deduplicates on", evt.id === "q1");

  const inbound = readEvent({
    type: "message.received",
    data: { object: { id: "q2", from: "+15415550101", text: "ok see you" } },
  });
  chk("an inbound reply is not a delivery event", !isDelivered(inbound));
}

console.log("\n-- a call that arrives at the texts endpoint --\n");
//
// THE BUG THIS SECTION EXISTS FOR, and it had been live since the webhook
// was created.
//
// Quo replaced its four per-type webhook endpoints with one unified
// subscription, so the natural setup is a single webhook carrying call
// events and message events together — and a subscription has exactly one
// URL. Sky Blue's was pointed at /api/sms-inbound with `call.completed`
// ticked alongside the message events.
//
// A call payload has no `text` and no `to`. It fell past both delivery
// branches, hit the outgoing-copy gate (its type is not "received"),
// reached keepAppMessage, found nothing to keep, and returned 200. No row,
// no warning, no log line, no error anywhere. Every call placed since the
// webhook was set up disappeared into the texts endpoint, and the symptom
// was indistinguishable from Quo never calling at all.

{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/functions/sms-inbound.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  // SCOPED TO THE REQUEST HANDLER, not to the whole file.
  //
  // isDelivered and the outgoing gate both appear earlier in the file as
  // definitions, so comparing positions across the whole source compares
  // where things are WRITTEN rather than where they RUN — and reported the
  // routing as last when it is first. The same mistake, in the same shape,
  // as the one in verify/quo-calls.mjs.
  const entry = src.slice(src.indexOf("export default async (req)"));
  const gate = entry.search(/\/\^call\\\./);
  const delivered = entry.indexOf("isDelivered(evt)");
  const outgoingGate = entry.indexOf('evt.direction === "outgoing"');

  chk("THE POINT: a call event is handed to the call handler",
    gate > -1 && /handleCallEvent\(payload\)/.test(entry),
    "a call payload has no text and no recipient, so every branch below " +
      "silently drops it and answers 200");

  chk("...before anything treats it as a message",
    gate > -1 && delivered > -1 && gate < delivered && gate < outgoingGate,
    `routing at ${gate}, delivery branch at ${delivered}, outgoing gate at ${outgoingGate}`);

  // Matched on the TYPE, not on the absence of text. "It has no body so it
  // must be a call" would also catch a photo sent with no caption, which is
  // a message and belongs on the thread.
  chk("THE POINT: routed on the event type, not on an empty body",
    /\^call\\\./.test(entry) && !/!evt\.body[\s\S]{0,40}handleCallEvent/.test(entry),
    "an MMS with no caption is a message, not a call");

  // And the real parser agrees about what a call looks like.
  const callEvt = readEvent({
    type: "call.completed",
    data: { resource: { id: "AC1", direction: "outgoing", status: "answered", duration: 252 } },
  });
  chk("a call really does look like nothing to the message parser",
    !isDelivered(callEvt) && String(callEvt.body) === "" && callEvt.to == null,
    "which is exactly why it vanished without a sound");
}

console.log("\n-- the rule that must not break --\n");

{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/functions/sms-inbound.mjs", "utf8");

  // The outbound gate still exists and still returns before the inbound
  // handling. Deleting it to "simplify" would file our own messages as the
  // customer's, and a message reading "stop" would opt them out.
  //
  // Matched on the WHOLE gate, not on the condition. The first version looked
  // for `evt.direction === "outgoing"` and found the copy inside
  // keepAppMessage, so deleting the gate entirely left this passing.
  const GATE =
    'if (evt.direction === "outgoing" || (evt.type && !/received/i.test(evt.type))) {';
  const gate = src.indexOf(GATE);
  const inboundWork = src.indexOf("record_inbound_sms");
  chk("THE POINT: outbound copies still return before the inbound handling",
    gate > -1 && gate < inboundWork,
    "everything past that gate treats the event as the customer talking");
  chk("...and that gate returns rather than falling through",
    gate > -1 &&
      /^\s*await keepAppMessage\(evt\);\s*\n\s*return new Response/m.test(
        src.slice(gate, gate + 260)
      ),
    src.slice(gate, gate + 160));

  chk("THE POINT: the handler does not decide which copies are its own",
    !/provider_sid|already sent|our own/i.test(
      src.slice(src.indexOf("async function keepAppMessage"), src.indexOf("Is this Quo telling us"))
    ),
    "that judgement needs the table, and lives in record_app_sms()");

  // Not just "has a try/catch" — the first version asserted that, and a catch
  // block that rethrows still has one.
  const fn = src.slice(
    src.indexOf("async function keepAppMessage"),
    src.indexOf("Is this Quo telling us")
  );
  const catchBody = fn.slice(fn.indexOf("} catch"));
  chk("keepAppMessage catches its own failures",
    /\} catch/.test(fn), "Quo retries on any non-2xx");
  chk("THE POINT: and swallows them rather than rethrowing",
    !/\bthrow\b/.test(catchBody),
    "a throw here becomes a 5xx at Quo, and a retry storm is worse than a lost line");

  chk("it refuses an event with no recipient rather than guessing from `from`",
    /if \(!evt\.to \|\|/.test(src),
    "filing it against the business's own number would be worse than dropping it");
}

console.log(bad === 0 ? "\nall ok — the webhook keeps what it used to throw away\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
