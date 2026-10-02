// The client half of the invoice fix.
//
// verify/invoice-truth.sql proves the database cannot be made to lie. It
// cannot see any of this: whether completeJob() marks an emailed invoice
// paid, whether saveInvoiceOnJob() still writes the paid column behind the
// RPC's back, or whether the one caller allowed to claim a send actually
// claims it. Those are decided in JavaScript.
//
// THE MODULES UNDER TEST ARE NOT STUBBED. Only supabaseClient is. That is
// the whole discipline here: on 28 Sep eleven green suites sat on top of a
// dead feature because every one of them replaced followUps.mjs with a stub
// at bundle time, so the broken line never ran. Here the real jobService and
// the real invoiceService are bundled and called, and the stub sits at the
// network edge where a stub belongs.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

// Records every call instead of talking to anything. `from(...).update(...)`
// and `.rpc(...)` both resolve with { data, error } the way supabase-js does,
// because a stub that throws or returns a bare value tests the stub.
const stub = {
  name: "stub-supabase",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({
      path: a.path,
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `
        const log = () => globalThis.__calls;
        const done = { data: null, error: null };
        export const supabase = {
          from(table) {
            const rec = { table };
            const chain = {
              update(values) { rec.op = "update"; rec.values = values; return chain; },
              insert(values) { rec.op = "insert"; rec.values = values; return chain; },
              select() { return chain; },
              eq(col, val) { rec.eq = [col, val]; log().push(rec); return Promise.resolve(done); },
              single() { log().push(rec); return Promise.resolve({ data: globalThis.__row ?? {}, error: null }); },
              then(res) { log().push(rec); return Promise.resolve(done).then(res); },
            };
            return chain;
          },
          rpc(fn, args) {
            log().push({ op: "rpc", fn, args });
            return Promise.resolve(done);
          },
          auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
        };
      `,
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "inv-"));

async function bundle(entry, name) {
  const out = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [stub],
    logLevel: "warning",
  });
  return import(out);
}

const jobs = await bundle("src/services/jobService.js", "jobs");
const invoices = await bundle("src/services/invoiceService.js", "invoices");

const reset = () => {
  globalThis.__calls = [];
};
const jobUpdate = () =>
  globalThis.__calls.find((c) => c.table === "jobs" && c.op === "update");
const rpcCall = (fn) => globalThis.__calls.find((c) => c.op === "rpc" && c.fn === fn);

// --- completed is not the same as paid --------------------------------------

for (const method of ["cash", "check", "square", "card", "tap"]) {
  reset();
  await jobs.completeJob(
    { id: "j1", notes: null, lead_id: null, is_extra: true },
    { finalPrice: 100, paymentMethod: method, paymentNotes: null }
  );
  chk(
    `completing with ${method} marks the job paid`,
    jobUpdate()?.values?.paid === true,
    `got ${JSON.stringify(jobUpdate()?.values?.paid)}`
  );
}

reset();
await jobs.completeJob(
  { id: "j1", notes: null, lead_id: null, is_extra: true },
  { finalPrice: 3280, paymentMethod: "invoice", paymentNotes: null }
);
chk(
  "THE POINT: completing by emailed invoice does NOT mark the job paid",
  jobUpdate()?.values?.paid === false,
  `got ${JSON.stringify(jobUpdate()?.values?.paid)}`
);
chk(
  "and it still records the method and the price",
  jobUpdate()?.values?.payment_method === "invoice" &&
    Number(jobUpdate()?.values?.final_price) === 3280
);

// --- recording an invoice goes through the RPC, and never writes paid -------

reset();
await invoices.saveInvoiceOnJob("j1", {
  invoiceId: "inv_1",
  publicUrl: "https://sq/i/1",
  status: "UNPAID",
});

chk(
  "recording an invoice goes through record_invoice_on_job",
  Boolean(rpcCall("record_invoice_on_job")),
  `calls: ${JSON.stringify(globalThis.__calls.map((c) => c.fn || c.table))}`
);

chk(
  "THE POINT: recording an invoice writes no paid column at all",
  !globalThis.__calls.some(
    (c) => c.op === "update" && c.values && "paid" in c.values
  ),
  "a direct write to jobs.paid is back"
);

chk(
  "THE POINT: it does not write the jobs table directly",
  !globalThis.__calls.some((c) => c.table === "jobs" && c.op === "update"),
  "bypassing the RPC also bypasses the honest-wording flag"
);

chk(
  "the invoice id, url and status reach the RPC",
  rpcCall("record_invoice_on_job")?.args?.p_invoice_id === "inv_1" &&
    rpcCall("record_invoice_on_job")?.args?.p_url === "https://sq/i/1" &&
    rpcCall("record_invoice_on_job")?.args?.p_status === "UNPAID"
);

// --- who may claim a send ---------------------------------------------------

chk(
  "THE POINT: emailed defaults to FALSE when the caller says nothing",
  rpcCall("record_invoice_on_job")?.args?.p_emailed === false,
  `got ${JSON.stringify(rpcCall("record_invoice_on_job")?.args?.p_emailed)}`
);

reset();
await invoices.saveInvoiceOnJob(
  "j1",
  { invoiceId: "inv_2", publicUrl: null, status: null },
  { emailed: true }
);
chk(
  "a caller that really sent it can say so",
  rpcCall("record_invoice_on_job")?.args?.p_emailed === true
);
chk(
  "a missing url is sent as null rather than undefined",
  rpcCall("record_invoice_on_job")?.args?.p_url === null,
  "undefined is dropped from the JSON body and the RPC sees no argument"
);

// --- the one caller in the app that claims a send ---------------------------
//
// Read as source rather than executed: CompleteJob.jsx is a React page with a
// router, a Square form and a dozen imports, and standing all that up to
// check one argument would test the harness. What matters is that exactly one
// call site passes emailed: true and it is the one directly below the call
// that publishes the invoice.

const { readFileSync } = await import("node:fs");
const page = readFileSync("src/pages/schedule/CompleteJob.jsx", "utf8");

const sites = [...page.matchAll(/saveInvoiceOnJob\(([^;]*?)\);/gs)];
chk("CompleteJob records the invoice exactly once", sites.length === 1,
  `${sites.length} call sites`);

// The claim moved up a level when the page learned to ATTACH an invoice
// Square had already sent as well as create one. saveInvoiceOnJob is now
// called once, with whatever finalize() was told; it is finalize's callers
// that decide, and there are exactly two of them.
chk(
  "the one call site passes the flag through rather than hardcoding it",
  /\{ emailed \}/.test(sites[0]?.[1] ?? ""),
  "hardcoding emailed here would make both paths claim the same thing"
);

const claims = [...page.matchAll(/finalize\(\{[^}]*?emailed:\s*(true|false)/gs)].map(
  (m) => m[1]
);
chk(
  "THE POINT: exactly one path through the page claims the CRM emailed it",
  claims.filter((c) => c === "true").length === 1,
  `${claims.filter((c) => c === "true").length} paths claim a send`
);
chk(
  "and at least one path explicitly does not",
  claims.includes("false"),
  "attaching an invoice Square already sent must not claim we sent it"
);

chk(
  "the invoice is created before it is recorded",
  page.indexOf("createSquareInvoice") < page.indexOf("saveInvoiceOnJob"),
  "recording a send before making it is claiming one that has not happened"
);

console.log(bad === 0 ? "\nInvoice client behaviour holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
