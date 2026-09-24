// Tests for the email delivery code, and for whose name goes on a message.
//
// Three of these matter more than the rest:
//
//   * that a quote signs itself with the person who SENT it. The old
//     behaviour — the word "Jordan" typed into the message template — is the
//     kind of bug that produces no error, no warning, and a perfectly
//     deliverable text that is simply wrong. Only a test notices.
//
//   * that sendEmail refuses an address the database has closed, and that it
//     only does so on an explicit yes. Getting the first wrong means a dead
//     address is emailed nightly forever; getting the second wrong means the
//     business silently stops emailing ANYONE.
//
//   * that a send is recorded even when it fails. The whole point of
//     db/email-delivery.sql is that a customer who was never reached should
//     be visible, and a failure that isn't written down is invisible.
//
// The modules under test reach the database through db.mjs, which is bundled
// with that import stubbed so nothing here can touch the network.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /(followUps|db)\.mjs$/ }, (a) => ({
      path: a.path,
      namespace: "fu",
    }));
    b.onLoad({ filter: /.*/, namespace: "fu" }, () => ({
      contents:
        "export async function rpc(fn, args) { " +
        "  (globalThis.__calls ||= []).push({ fn, args }); " +
        "  if (globalThis.__rpc) return globalThis.__rpc(fn, args); " +
        "  throw new Error('no network in tests'); } " +
        "export async function rpcQuietly(fn, args) { " +
        "  try { return await rpc(fn, args); } catch { return null; } } " +
        "export function supabaseHeaders() { return {}; } " +
        // followUps.mjs exports more than rpc, but nothing under test here
        // uses the rest, and a stub that invents behaviour is worse than one
        // that is missing it.
        "export function unsubToken() { return 'tok'; }",
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "emailjs-"));
const out = "verify/.email-js-bundle.mjs";

await build({
  entryPoints: [join(dir, "entry.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  plugins: [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /entry\.js$/ }, (a) => ({ path: a.path, namespace: "e" }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: `
            export { quoteSms, nudgeOpenedSms, nudgeUnopenedSms, reminderSms, itsUs, usAt } from "${process.cwd()}/netlify/lib/sms.mjs";
            export { sendEmail, isTrue } from "${process.cwd()}/netlify/lib/email.mjs";
            export { emailTheReminder, reminderHtml, reminderTimes } from "${process.cwd()}/netlify/lib/reminderEmail.mjs";
            export { emailTheQuote, quoteHtml } from "${process.cwd()}/netlify/lib/quoteEmail.mjs";
            export { previewSms } from "${process.cwd()}/netlify/lib/smsRun.mjs";
            export { readEmailEvent } from "${process.cwd()}/netlify/functions/email-events.mjs";
            export { default as emailWebhook } from "${process.cwd()}/netlify/functions/email-events.mjs";
          `,
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
    stub,
  ],
  logLevel: "warning",
});

const M = await import("./.email-js-bundle.mjs");

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

// ---------------------------------------------------------------------------
// Whose name is on it
// ---------------------------------------------------------------------------

chk("a signature uses the sender's first name",
    M.itsUs("Hayden Mortensen") === "it's Hayden with Sky Blue Cleaning",
    M.itsUs("Hayden Mortensen"));
chk("and the company when there is no name",
    M.itsUs(null) === "it's Sky Blue Cleaning", M.itsUs(null));
chk("an empty string is not a name",
    M.itsUs("   ") === "it's Sky Blue Cleaning", M.itsUs("   "));

// firstName() answers "there" for an empty string, which is the right
// greeting for a customer and a nonsense signature. This is the assertion
// that would catch the two being confused.
chk("THE POINT: nobody is ever signed as 'there'",
    !/there/.test(M.itsUs("")) && !/there/.test(M.usAt("")),
    `${M.itsUs("")} / ${M.usAt("")}`);

chk("the other phrasing also uses the sender",
    M.usAt("Hayden Mortensen") === "Hayden at Sky Blue Cleaning",
    M.usAt("Hayden Mortensen"));

{
  const q = M.quoteSms({
    customerName: "Judy Alvarez",
    amount: 449,
    token: "tok1",
    sentByName: "Hayden Mortensen",
  });

  // THE POINT. This is the bug the whole change exists for: a quote Hayden
  // sent that introduces him as Jordan sends the customer's reply to the
  // wrong brother, and nothing anywhere errors.
  chk("THE POINT: a quote Hayden sent says Hayden", /Hayden/.test(q), q);
  chk("THE POINT: and does not say Jordan", !/Jordan/.test(q), q);
  chk("the customer is still greeted by name", /Hey Judy/.test(q), q);
  chk("and the amount and link survive",
      /\$449/.test(q) && /\/q\/tok1/.test(q), q);

  const anon = M.quoteSms({ customerName: "Judy", amount: 449, token: "tok1" });
  chk("a quote with no sender signs as the company",
      /it's Sky Blue Cleaning/.test(anon) && !/Jordan/.test(anon), anon);
}

for (const [name, fn] of [
  ["unopened nudge", M.nudgeUnopenedSms],
  ["opened nudge", M.nudgeOpenedSms],
]) {
  const body = fn({
    customerName: "Judy",
    amount: 300,
    token: "tok2",
    sentByName: "Hayden Mortensen",
  });
  chk(`an ${name} signs as the sender`, /Hayden/.test(body) && !/Jordan/.test(body), body);

  const anon = fn({ customerName: "Judy", amount: 300, token: "tok2" });
  chk(`an ${name} with no sender signs as the company`,
      /Sky Blue Cleaning/.test(anon) && !/Jordan/.test(anon), anon);
}

// The reminder never carried a name and still should not: it is from the
// business, not from a person, and nobody is waiting to hear back from a
// particular brother about whether their windows are being cleaned.
chk("a reminder is still from the company",
    !/Jordan|Hayden/.test(M.reminderSms({ customerName: "Judy", startsAt: new Date() })));

// ---------------------------------------------------------------------------
// The nightly nudge carries the name through
// ---------------------------------------------------------------------------
//
// Testing the templates alone would not catch a run that never passes
// sender_name to them — which is exactly the shape of bug that made the
// daily-schedule suite pass while the service ignored its argument.

{
  globalThis.__rpc = async (fn) => {
    if (fn === "sms_due_quote_nudges") {
      return [{
        quote_id: "q1", lead_id: "l1", customer_id: null, token: "tok3",
        amount: 275, customer_name: "Judy Alvarez", phone: "+15415550101",
        kind: "nudge_sent", sender_name: "Hayden Mortensen",
      }];
    }
    return [];
  };

  const preview = await M.previewSms({ limit: 5 });
  const nudge = preview.find((p) => p.kind === "nudge_sent");

  chk("THE POINT: the nightly nudge is composed with the quote's sender",
      Boolean(nudge) && /Hayden/.test(nudge.body) && !/Jordan/.test(nudge.body),
      nudge?.body);

  delete globalThis.__rpc;
}

// ---------------------------------------------------------------------------
// Reading a Resend event
// ---------------------------------------------------------------------------

{
  const bounced = M.readEmailEvent({
    type: "email.bounced",
    data: {
      email_id: "re_1",
      to: ["judy@example.com"],
      subject: "Your quote",
      bounce: { type: "Permanent", subType: "NoEmail", message: "mailbox does not exist" },
    },
  });
  chk("a bounce is read as bounced", bounced.status === "bounced", bounced.status);
  chk("with the provider id", bounced.providerId === "re_1");
  chk("and the address out of the array", bounced.to === "judy@example.com", String(bounced.to));

  // THE POINT. Resend's own verdict is authoritative and has to survive into
  // the reason string, because sb_email_permanent() is what reads it — a
  // reason of "mailbox does not exist" alone would still match, but
  // "Transient: mailbox full" vs "Permanent: mailbox full" is the whole
  // difference between keeping a customer and losing one.
  chk("THE POINT: the Permanent/Transient verdict is carried through",
      /Permanent/.test(bounced.reason || ""), bounced.reason);

  const soft = M.readEmailEvent({
    type: "email.bounced",
    data: { email_id: "re_2", to: ["sam@example.com"],
            bounce: { type: "Transient", message: "mailbox full" } },
  });
  chk("a transient bounce says so", /Transient/.test(soft.reason || ""), soft.reason);

  chk("a complaint is read as complained",
      M.readEmailEvent({ type: "email.complained", data: { email_id: "re_3", to: ["p@x.com"] } })
        .status === "complained");
  chk("a delivery is read as delivered",
      M.readEmailEvent({ type: "email.delivered", data: { email_id: "re_4" } })
        .status === "delivered");

  // A delay is not a delivery. Matching on "deliver" alone would turn every
  // delayed message into a confirmed one.
  chk("THE POINT: a delivery DELAY is not a delivery",
      M.readEmailEvent({ type: "email.delivery_delayed", data: { email_id: "re_5" } })
        .status === null);
  chk("an open is ignored",
      M.readEmailEvent({ type: "email.opened", data: { email_id: "re_6" } }).status === null);
  chk("so is an empty payload", M.readEmailEvent({}).status === null);
  chk("and one that is not an object at all",
      M.readEmailEvent(null).status === null);
}

// ---------------------------------------------------------------------------
// Only an explicit yes closes an address
// ---------------------------------------------------------------------------

chk("true is true", M.isTrue(true));
chk("a single-element array is unwrapped", M.isTrue([true]));
chk("so is an object", M.isTrue({ sb_email_unreachable: true }));
chk("false is false", !M.isTrue(false));

// THE POINT. `Boolean([])` is TRUE in JavaScript, and [] is what PostgREST
// hands back for a call that returned no rows. Reading that as "this address
// is closed" would stop the CRM emailing anybody at all, silently.
chk("THE POINT: an empty array is NOT a yes", !M.isTrue([]));
chk("null is not a yes", !M.isTrue(null));
chk("undefined is not a yes", !M.isTrue(undefined));

// ---------------------------------------------------------------------------
// Sending, and writing it down
// ---------------------------------------------------------------------------

{
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test";
  process.env.RECEIPT_FROM = "hello@skybluecleaningco.com";

  let posted = null;
  let resendOk = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      posted = JSON.parse(init.body);
      return resendOk
        ? { ok: true, json: async () => ({ id: "re_sent_1" }) }
        : { ok: false, status: 422, json: async () => ({ message: "invalid from" }) };
    }
    return realFetch(url, init);
  };

  // --- a normal send ---
  globalThis.__calls = [];
  globalThis.__rpc = async (fn) => (fn === "sb_email_unreachable" ? false : null);

  let res = await M.sendEmail({
    kind: "quote", to: "judy@example.com", subject: "Your quote",
    html: "<p>hi</p>", quoteId: "q1", customerId: "c1",
  });

  chk("a send reports success", res.ok && res.id === "re_sent_1", JSON.stringify(res));
  chk("it went to the right address", posted?.to?.[0] === "judy@example.com");
  chk("with a From address from the environment",
      posted?.from === "hello@skybluecleaningco.com", posted?.from);

  const recorded = globalThis.__calls.find((c) => c.fn === "record_email_sent");
  chk("THE POINT: the send is recorded", Boolean(recorded));
  chk("with the provider id a bounce will arrive under",
      recorded?.args?.p_provider_id === "re_sent_1", recorded?.args?.p_provider_id);
  chk("and the records it belongs to",
      recorded?.args?.p_quote_id === "q1" && recorded?.args?.p_customer_id === "c1");
  chk("and a status of sent", recorded?.args?.p_status === "sent");

  // --- a send Resend refuses ---
  globalThis.__calls = [];
  resendOk = false;
  res = await M.sendEmail({ kind: "quote", to: "judy@example.com", subject: "x", html: "y" });

  chk("a refused send reports the reason", !res.ok && /invalid from/.test(res.reason), res.reason);

  // THE POINT. A failure that isn't written down is invisible, which is the
  // exact hole this whole feature exists to close.
  const failRow = globalThis.__calls.find((c) => c.fn === "record_email_sent");
  chk("THE POINT: a failed send is recorded too", Boolean(failRow));
  chk("as failed, meaning safe to send again",
      failRow?.args?.p_status === "failed", failRow?.args?.p_status);
  resendOk = true;

  // --- a closed address ---
  globalThis.__calls = [];
  posted = null;
  globalThis.__rpc = async (fn) => (fn === "sb_email_unreachable" ? true : null);

  res = await M.sendEmail({ kind: "follow_up", to: "dead@example.com", subject: "x", html: "y" });

  chk("THE POINT: a closed address is not emailed", posted === null);
  chk("and it is reported as skipped, not as an error",
      res.skipped === "unreachable", JSON.stringify(res));
  chk("and nothing is recorded for a send that never happened",
      !globalThis.__calls.some((c) => c.fn === "record_email_sent"));

  // --- a person overriding it ---
  posted = null;
  res = await M.sendEmail({
    kind: "quote", to: "dead@example.com", subject: "x", html: "y", force: true,
  });
  chk("a person pressing Send can override the closed list",
      posted !== null && res.ok, JSON.stringify(res));

  // --- the lookup answering with no rows ---
  //
  // THE POINT, and the reason isTrue() exists at all. The unit tests above
  // prove isTrue([]) is false; this proves sendEmail actually USES it. With
  // Boolean() here instead, an empty result — which is what PostgREST hands
  // back for a call that returned no rows — reads as "this address is
  // closed", and the CRM silently stops emailing every customer it has.
  //
  // Without this assertion that substitution passes the entire suite.
  posted = null;
  globalThis.__rpc = async (fn) => (fn === "sb_email_unreachable" ? [] : null);
  res = await M.sendEmail({ kind: "quote", to: "judy@example.com", subject: "x", html: "y" });
  chk("THE POINT: an empty lookup result does not block the send",
      posted !== null && res.ok, JSON.stringify(res));

  // --- the check itself failing ---
  //
  // Sending to a dead address costs nothing. Not sending a real quote
  // because a lookup timed out costs a job, so this has to fail OPEN.
  posted = null;
  globalThis.__rpc = async (fn) => {
    if (fn === "sb_email_unreachable") throw new Error("supabase is down");
    return null;
  };
  res = await M.sendEmail({ kind: "quote", to: "judy@example.com", subject: "x", html: "y" });
  chk("THE POINT: a failed lookup does not block the send", posted !== null && res.ok);

  globalThis.fetch = realFetch;
  delete globalThis.__rpc;
  delete globalThis.__calls;
  delete process.env.RESEND_API_KEY;
  delete process.env.RECEIPT_FROM;
}

// ---------------------------------------------------------------------------
// What the confirmation email says
// ---------------------------------------------------------------------------

{
  // 9am Pacific on a Tuesday, expressed in UTC.
  const startsAt = "2026-09-29T16:00:00Z";
  const { day, time } = M.reminderTimes(startsAt);

  // THE POINT. The server thinks in UTC; the customer reads their own clock.
  // An hour out on a confirmation is worse than no confirmation, because
  // they will believe it.
  chk("THE POINT: the time is the customer's local time, not UTC",
      time === "9:00 AM", time);
  chk("and the day is named", /Tuesday/.test(day), day);

  const html = M.reminderHtml({
    customerName: "Trish Roark",
    startsAt,
    address: "14 Oak St",
    services: "Exterior windows",
  });
  chk("the confirmation greets them by first name", /Hi Trish,/.test(html));
  chk("and says when", /9:00 AM/.test(html) && /Tuesday/.test(html));
  chk("and where", /14 Oak St/.test(html));
  chk("and says why it arrived by email",
      /didn't go through/.test(html) || /didn&#39;t go through/.test(html));
  chk("and is not a quote", !/Accept this quote/.test(html));

  // An address with a quote in it would break out of the attribute and the
  // layout. Every other template escapes; this one has to as well.
  const nasty = M.reminderHtml({
    customerName: "Trish",
    startsAt,
    address: '14 "Oak" <b>St</b>',
  });
  chk("the address is escaped", !/<b>St<\/b>/.test(nasty), nasty.slice(0, 40));
}

// ---------------------------------------------------------------------------
// What the quote email says
// ---------------------------------------------------------------------------

{
  const html = M.quoteHtml({
    customerName: "Judy",
    amount: 449,
    services: ["Residential window washing"],
    link: "https://crm.example/q/tok",
    expires: "October 10",
    sentByName: "Hayden Mortensen",
  });
  chk("THE POINT: the quote email is signed by whoever sent it",
      /Hayden/.test(html) && !/Jordan/.test(html));

  const anon = M.quoteHtml({
    customerName: "Judy", amount: 449, services: [],
    link: "https://crm.example/q/tok", expires: "October 10",
  });
  chk("and by the company when nobody is named",
      /Sky Blue Cleaning Co\./.test(anon) && !/Jordan/.test(anon));
}

// ---------------------------------------------------------------------------
// The webhook refuses anything it cannot prove came from Resend
// ---------------------------------------------------------------------------

{
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "x", to: ["a@b.c"] } });

  const was = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;

  let res = await M.emailWebhook(new Request("https://example.test/x", { method: "POST", body }));
  // THE POINT. An endpoint that waves requests through when a variable is
  // missing is an unsigned endpoint the first time somebody restores
  // Netlify's environment from a backup — and it would look fine.
  chk("THE POINT: with no secret set, nothing is accepted", res.status === 503, String(res.status));

  process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("hunter2").toString("base64");
  res = await M.emailWebhook(new Request("https://example.test/x", { method: "POST", body }));
  chk("an unsigned request is refused", res.status === 401, String(res.status));

  res = await M.emailWebhook(
    new Request("https://example.test/x", {
      method: "POST",
      body,
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,not-even-close",
      },
    })
  );
  chk("and so is a forged signature", res.status === 401, String(res.status));

  if (was === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = was;
}

console.log(bad === 0 ? "\nEmail delivery holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
