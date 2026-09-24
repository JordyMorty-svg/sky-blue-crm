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

console.log(bad === 0 ? "\nReconciling holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
