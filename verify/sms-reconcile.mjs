// Tests for asking Quo what became of a text.
//
// Two of these matter more than the rest:
//
//   * a Quo outage must NOT mark messages as undelivered. "We couldn't ask"
//     and "the carrier refused it" are different facts, and conflating them
//     would, in one bad afternoon, close every phone number in the address
//     book and stop the CRM texting anybody ever again.
//
//   * one unreadable message must not abandon the batch. The whole point of
//     a catch-up pass is that it catches up.
//
// The module reaches the database through db.mjs and Quo through fetch; both
// are stubbed, so nothing here touches the network.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /(followUps|db)\.mjs$/ }, (a) => ({ path: a.path, namespace: "fu" }));
    b.onLoad({ filter: /.*/, namespace: "fu" }, () => ({
      contents:
        "export async function rpc(fn, args) { " +
        "  (globalThis.__calls ||= []).push({ fn, args }); " +
        "  if (globalThis.__rpc) return globalThis.__rpc(fn, args); " +
        "  throw new Error('no network in tests'); } " +
        "export async function rpcQuietly(fn, args) { " +
        "  try { return await rpc(fn, args); } catch { return null; } } " +
        "export function supabaseHeaders() { return {}; }",
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "recon-"));
const out = "verify/.sms-reconcile-bundle.mjs";

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
            export { askQuo, reconcileSms } from "${process.cwd()}/netlify/lib/smsReconcile.mjs";
            export { sendItAnotherWay } from "${process.cwd()}/netlify/lib/anotherWay.mjs";
            export { isDelivered, isDeliveryFailure } from "${process.cwd()}/netlify/functions/sms-inbound.mjs";
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

const M = await import("./.sms-reconcile-bundle.mjs");

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

process.env.QUO_API_KEY = "qk_test";

/** A fake Quo that answers with whatever the test says. */
function quoSaying(byId) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url: String(url), init });
    const id = String(url).split("/").pop();
    const answer = byId[id];

    if (answer === "404") return { status: 404, ok: false };
    if (answer === "500") {
      return { status: 500, ok: false, text: async () => "upstream exploded" };
    }
    if (answer === "throw") throw new Error("socket hang up");

    return {
      status: 200,
      ok: true,
      json: async () => ({ data: { id, status: answer } }),
    };
  };
  impl.seen = seen;
  return impl;
}

// ---------------------------------------------------------------------------
// Reading one verdict
// ---------------------------------------------------------------------------

{
  const fetchImpl = quoSaying({ m1: "undelivered" });
  const v = await M.askQuo("m1", { fetchImpl });
  chk("a verdict is read from Quo", v.status === "undelivered", v.status);

  const req = fetchImpl.seen[0];
  chk("it asks the right endpoint", /\/messages\/m1$/.test(req.url), req.url);

  // The API key goes in bare. Prefixing it 401s in a way that looks exactly
  // like a wrong key — the same trap postToQuo() documents.
  chk("THE POINT: the key is sent bare, not as a Bearer token",
      req.init.headers.Authorization === "qk_test",
      req.init.headers.Authorization);

  chk("a 404 is 'unknown', not a failure",
      (await M.askQuo("m1", { fetchImpl: quoSaying({ m1: "404" }) })).status === "unknown");

  let threw = false;
  try {
    await M.askQuo("m1", { fetchImpl: quoSaying({ m1: "500" }) });
  } catch {
    threw = true;
  }
  chk("a 500 throws rather than inventing a verdict", threw);
}

// ---------------------------------------------------------------------------
// A pass over everything waiting
// ---------------------------------------------------------------------------

function dbSaying(sids) {
  return async (fn) => {
    if (fn === "sms_awaiting_verdict") return sids.map((s) => ({ out_sid: s }));
    if (fn === "mark_sms_undelivered") {
      return [{ out_kind: "quote", out_phone: "+15415551234", out_permanent: true }];
    }
    return null;
  };
}

{
  globalThis.__calls = [];
  globalThis.__rpc = dbSaying(["a", "b", "c", "d"]);

  const summary = await M.reconcileSms({
    fetchImpl: quoSaying({ a: "delivered", b: "undelivered", c: "sent", d: "404" }),
  });

  chk("every waiting message is asked about", summary.checked === 4, String(summary.checked));
  chk("a delivered one is recorded", summary.delivered === 1, String(summary.delivered));
  chk("a refused one is recorded", summary.undelivered === 1, String(summary.undelivered));
  chk("one still in flight is left alone", summary.still_waiting === 1, String(summary.still_waiting));
  chk("one Quo has never heard of is not a failure", summary.unknown === 1, String(summary.unknown));

  const marked = globalThis.__calls.filter((c) => c.fn === "mark_sms_undelivered");
  chk("THE POINT: only the refused one is marked undelivered",
      marked.length === 1 && marked[0].args.p_sid === "b",
      JSON.stringify(marked.map((m) => m.args.p_sid)));

  // Quo's documented message object has no error field. A reason of "" or
  // undefined would reach sb_sms_permanent() as nothing at all; this says
  // plainly where the verdict came from.
  chk("and carries a reason even though Quo gives none",
      typeof marked[0].args.p_error === "string" && marked[0].args.p_error.length > 10,
      marked[0].args.p_error);

  const delivered = globalThis.__calls.filter((c) => c.fn === "mark_sms_delivered");
  chk("only the delivered one is marked delivered",
      delivered.length === 1 && delivered[0].args.p_sid === "a");
}

// ---------------------------------------------------------------------------
// When Quo is down
// ---------------------------------------------------------------------------

{
  globalThis.__calls = [];
  globalThis.__rpc = dbSaying(["a", "b", "c"]);

  // Guarded, like the batch test below: a pass that throws must read as a
  // named failure, not as a stack trace that stops the suite before the
  // assertions that would have explained it.
  let summary = null;
  let threw = null;
  try {
    summary = await M.reconcileSms({
      fetchImpl: quoSaying({ a: "500", b: "throw", c: "500" }),
    });
  } catch (e) {
    threw = e;
  }

  chk("an outage does not throw the pass", threw === null, String(threw?.message || ""));

  // THE POINT. "We couldn't ask" is not "the carrier refused it". Treating
  // an outage as a verdict would mark every recent message undelivered and
  // close every number in the address book — silently, in one afternoon.
  chk("THE POINT: an outage marks NOTHING as undelivered",
      !globalThis.__calls.some((c) => c.fn === "mark_sms_undelivered"),
      JSON.stringify(globalThis.__calls.map((c) => c.fn)));
  chk("and nothing as delivered either",
      !globalThis.__calls.some((c) => c.fn === "mark_sms_delivered"));
  chk("but it reports the problem rather than looking healthy",
      summary?.problems?.length === 3, String(summary?.problems?.length));
}

// ---------------------------------------------------------------------------
// One bad message must not take the batch down
// ---------------------------------------------------------------------------

{
  globalThis.__calls = [];
  globalThis.__rpc = dbSaying(["a", "bad", "c"]);

  // Caught here rather than left to reject, so "it threw" reads as a named
  // failure instead of an unhandled rejection with a stack trace.
  let summary = null;
  let threw = null;
  try {
    summary = await M.reconcileSms({
      fetchImpl: quoSaying({ a: "delivered", bad: "throw", c: "undelivered" }),
    });
  } catch (e) {
    threw = e;
  }

  // THE POINT. The whole point of a catch-up pass is that it catches up.
  chk("THE POINT: one bad message does not throw the whole pass",
      threw === null, String(threw?.message || ""));
  chk("THE POINT: and the rest are still reconciled",
      summary?.delivered === 1 && summary?.undelivered === 1,
      JSON.stringify(summary));
  chk("and the broken one is named", summary?.problems?.[0]?.sid === "bad");
}

// ---------------------------------------------------------------------------
// Repeating a pass
// ---------------------------------------------------------------------------

{
  globalThis.__calls = [];
  // mark_sms_undelivered returns nothing the second time — that is what makes
  // the whole thing idempotent across nightly runs, and what stops a customer
  // being emailed a fallback quote once per run forever.
  globalThis.__rpc = async (fn) => {
    if (fn === "sms_awaiting_verdict") return [{ out_sid: "b" }];
    if (fn === "mark_sms_undelivered") return [];
    return null;
  };

  const summary = await M.reconcileSms({ fetchImpl: quoSaying({ b: "undelivered" }) });
  chk("THE POINT: a verdict already recorded is not reported twice",
      summary.undelivered === 0 && summary.failures.length === 0,
      JSON.stringify(summary));
}

// ---------------------------------------------------------------------------
// With no key configured
// ---------------------------------------------------------------------------

{
  const was = process.env.QUO_API_KEY;
  delete process.env.QUO_API_KEY;
  globalThis.__calls = [];
  globalThis.__rpc = dbSaying(["a"]);

  const summary = await M.reconcileSms({ fetchImpl: quoSaying({ a: "undelivered" }) });
  chk("with no Quo key it says so rather than half-running",
      summary.checked === 0 && /QUO_API_KEY/.test(summary.error || ""),
      JSON.stringify(summary));
  chk("and asks the database for nothing",
      globalThis.__calls.length === 0);

  process.env.QUO_API_KEY = was;
}

// ---------------------------------------------------------------------------
// The one webhook Quo does send
// ---------------------------------------------------------------------------

chk("a delivery event is recognised", M.isDelivered({ type: "message.delivered" }));
chk("so is a status of delivered", M.isDelivered({ status: "delivered" }));

// THE POINT. A delayed message has not arrived. Treating it as delivered
// would stop the reconciler ever asking about it again — the message would be
// recorded as having reached a handset it never reached, permanently.
chk("THE POINT: a delivery DELAY is not a delivery",
    !M.isDelivered({ type: "message.delivery_delayed" }));
chk("an incoming message is not a delivery",
    !M.isDelivered({ type: "message.received", status: "received" }));
chk("a failure is not a delivery",
    !M.isDelivered({ status: "undelivered" }));
chk("and the two branches never both fire",
    !(M.isDelivered({ status: "undelivered" }) && !M.isDeliveryFailure({ status: "undelivered" })));

// ---------------------------------------------------------------------------
// Finding a failure has to DO something about it
// ---------------------------------------------------------------------------
//
// THE POINT of this whole block, and the bug it was written for.
//
// "Email it instead" lived only inside the delivery-failure branch of
// sms-inbound.mjs — a branch fired by a webhook Quo does not publish. The
// feature was written, tested, shipped, and could never once have run. The
// only thing that actually discovers a refusal is this reconciler, and it
// marked the row and stopped there.
//
// Nothing about that was visible from either side: the webhook tests passed
// (the branch works, when something calls it) and the reconciler tests passed
// (it records the failure correctly). Only asking "and then what happens?"
// finds it.

{
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test";
  process.env.RECEIPT_FROM = "hello@skybluecleaningco.com";
  process.env.PUBLIC_URL = "https://crm.skybluecleaningco.com";

  let emailed = null;
  // Installed as the GLOBAL fetch as well as passed to the reconciler.
  // askQuo() takes an injected fetchImpl, but sendEmail() — three modules
  // down, inside the fallback — calls global fetch. Stubbing only the
  // injected one left the email path reaching for the real network, which is
  // why the first run of this block asserted "no Resend call was made"
  // against code that was working.
  const quoAnd = (byId) => {
    const quo = quoSaying(byId);
    const impl = async (url, init) => {
      if (String(url).includes("api.resend.com")) {
        emailed = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ id: "re_fb" }) };
      }
      return quo(url, init);
    };
    globalThis.fetch = impl;
    return impl;
  };

  // --- a refused quote ---
  emailed = null;
  globalThis.__rpc = async (fn) => {
    if (fn === "sms_awaiting_verdict") return [{ out_sid: "q1" }];
    if (fn === "mark_sms_undelivered") {
      return [{
        out_kind: "quote", out_quote_id: "quote-1", out_lead_id: "lead-1",
        out_phone: "+15415551234", out_permanent: true,
      }];
    }
    if (fn === "quote_for_email") {
      return [{
        out_token: "tok-judy", out_name: "Judy", out_email: "judy@example.com",
        out_amount: 449, out_expires: null, out_sender_name: "Hayden Mortensen",
      }];
    }
    if (fn === "sb_email_unreachable") return false;
    return null;
  };

  let summary = await M.reconcileSms({ fetchImpl: quoAnd({ q1: "undelivered" }) });

  chk("THE POINT: a refusal found by asking is emailed instead",
      emailed !== null, "no Resend call was made");
  chk("to the address on the record",
      emailed?.to?.[0] === "judy@example.com", JSON.stringify(emailed?.to));
  chk("and signed by whoever sent the quote",
      /Hayden/.test(emailed?.html || "") && !/Jordan/.test(emailed?.html || ""));
  chk("and the pass reports that it went",
      summary.failures[0]?.emailed === true, JSON.stringify(summary.failures));

  // --- a refused day-before confirmation ---
  //
  // The case the fifteen-minute poll exists for. Discovering at 4pm that this
  // afternoon's reminder was refused is only useful if something then emails
  // it — otherwise the CRM has a tidy record of a job nobody was told about.
  emailed = null;
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  globalThis.__rpc = async (fn) => {
    if (fn === "sms_awaiting_verdict") return [{ out_sid: "r1" }];
    if (fn === "mark_sms_undelivered") {
      return [{
        out_kind: "reminder", out_job_id: "job-1", out_customer_id: "cust-1",
        out_phone: "+15415552222", out_permanent: true,
      }];
    }
    if (fn === "reminder_for_email") {
      return [{
        out_name: "Trish", out_email: "trish@example.com",
        out_starts_at: tomorrow, out_address: "14 Oak St",
        out_services: "Exterior windows",
      }];
    }
    if (fn === "sb_email_unreachable") return false;
    return null;
  };

  summary = await M.reconcileSms({ fetchImpl: quoAnd({ r1: "undelivered" }) });

  chk("THE POINT: a refused day-before confirmation is emailed the same pass",
      emailed !== null, "no Resend call was made");
  chk("with the day and time in the subject",
      /cleaning your windows/i.test(emailed?.subject || ""), emailed?.subject);
  chk("and it is not the quote email",
      !/Accept this quote/i.test(emailed?.html || ""));

  // --- the second pass ---
  //
  // THE POINT. This now runs every fifteen minutes. If a repeat could resend,
  // a customer whose number is a landline would get the same quote email
  // ninety-six times a day.
  emailed = null;
  globalThis.__rpc = async (fn) => {
    if (fn === "sms_awaiting_verdict") return [{ out_sid: "q1" }];
    // Already recorded: mark_sms_undelivered gives nothing back the second
    // time, and that is the only thing standing between this and a mailbox
    // full of identical quotes.
    if (fn === "mark_sms_undelivered") return [];
    if (fn === "quote_for_email") {
      return [{
        out_token: "tok-judy", out_name: "Judy", out_email: "judy@example.com",
        out_amount: 449, out_expires: null,
      }];
    }
    if (fn === "sb_email_unreachable") return false;
    return null;
  };

  await M.reconcileSms({ fetchImpl: quoAnd({ q1: "undelivered" }) });
  chk("THE POINT: a second pass does not email it again", emailed === null);

  // --- no link to send ---
  //
  // A quote email whose Accept button goes nowhere is worse than none: the
  // customer believes they have been sent something and that we are waiting
  // on them.
  emailed = null;
  const savedUrl = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  delete process.env.URL;

  const out = await M.sendItAnotherWay({
    out_kind: "quote", out_quote_id: "quote-1", out_lead_id: "lead-1",
  });
  chk("THE POINT: with no site URL set, no broken link is emailed",
      emailed === null && out.sent === false, JSON.stringify(out));

  process.env.PUBLIC_URL = savedUrl;

  globalThis.fetch = realFetch;
  delete globalThis.__rpc;
  delete process.env.RESEND_API_KEY;
  delete process.env.RECEIPT_FROM;
  delete process.env.PUBLIC_URL;
}

// ---------------------------------------------------------------------------
// The schedule is what it says it is
// ---------------------------------------------------------------------------
//
// Read off disk rather than imported: the value is a string in a config
// export and a typo in it is a poller that runs once a day, or once a month,
// and looks exactly like one that works.

{
  const { readFileSync } = await import("node:fs");
  const poll = readFileSync("netlify/functions/poll-delivery.mjs", "utf8");
  const nightly = readFileSync("netlify/functions/send-sms.mjs", "utf8");

  chk("the poller runs every fifteen minutes",
      /schedule:\s*"\*\/15 \* \* \* \*"/.test(poll),
      (poll.match(/schedule:.*/) || [])[0]);

  // A short window on purpose. The poller is the fast path for something
  // that just happened; the nightly run is the catch-up, and if the poller
  // took the seven-day window too it would ask Quo about the same old
  // messages ninety-six times a day.
  chk("THE POINT: the poller asks about a SHORT window",
      /days:\s*2\b/.test(poll), (poll.match(/days:.*/) || [])[0]);
  chk("and the nightly run keeps the long one",
      /days:\s*7\b/.test(nightly), (nightly.match(/days:.*/) || [])[0]);
}

console.log(bad === 0 ? "\nReconciling holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
