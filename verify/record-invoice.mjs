// The Record-invoice screen, driven for real in a browser.
//
// What this is actually checking
// ------------------------------
// One thing above all others: THIS SCREEN MUST NEVER CLAIM THE CRM EMAILED
// ANYBODY.
//
// Its entire reason for existing is that Hayden sends invoices from the
// Square app, the CRM had no way to be told, and so on 30 Sep the id was
// typed into the Supabase table editor — which made the history say
// "Invoice emailed to the customer" three times for an invoice the CRM had
// never sent. db/invoice-truth.sql stopped the database inventing that. If
// this screen passes emailed: true, it puts the lie straight back.
//
// The component is bundled and mounted with real React. The ONLY thing
// stubbed is the network — a suite that stubs the component under test
// cannot see a bug in the component under test, which is exactly how
// `rpc is not defined` reached production on 28 Sep.

import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "ri-"));
const bundle = join(dir, "app.js");

// Two invoices and a draft. The draft is the point: list-invoices.mjs
// filters DRAFT server-side, and this fixture proves the component renders
// whatever it is handed rather than doing its own filtering — two places
// deciding what counts as "sent" is how they come to disagree.
const INVOICES = [
  {
    invoiceId: "inv_JEFF",
    invoiceNumber: "000011",
    status: "PAID",
    paid: true,
    amount: 3280,
    customerName: "Jeff Krueger",
    publicUrl: "https://squareup.com/pay/jeff",
    createdAt: "2026-09-29T19:11:00Z",
  },
  {
    invoiceId: "inv_TRAN",
    invoiceNumber: "000012",
    status: "UNPAID",
    paid: false,
    amount: 480,
    customerName: "Mai Tran",
    publicUrl: "https://squareup.com/pay/tran",
    createdAt: "2026-09-30T09:00:00Z",
  },
];

function entrySource({ paid, method, status = "completed", onJob = null, failLoad, onPick }) {
  return `
    import { createRoot } from "react-dom/client";
    import { createElement as h } from "react";
    import Modal from "./src/components/RecordInvoiceModal.jsx";

    window.__saves = [];
    window.__picks = [];
    // Initialised, not left undefined — an uninitialised flag reads as
    // whatever the last page left behind and makes the assertion a lie.
    window.__saved = false;
    window.__closed = 0;

    const job = {
      id: "job-1",
      paid: ${paid},
      status: ${JSON.stringify(status)},
      square_invoice_id: ${JSON.stringify(onJob)},
      payment_method: ${JSON.stringify(method)},
      lead: { name: "Jeff Krueger" },
    };

    const loadInvoices = async () => {
      ${failLoad ? 'throw new Error("Square is unreachable");' : ""}
      return { invoices: ${JSON.stringify(INVOICES)} };
    };

    const save = async (jobId, invoice, opts) => {
      window.__saves.push({ jobId, invoice, opts });
    };

    createRoot(document.getElementById("root")).render(
      h(Modal, {
        job,
        loadInvoices,
        save,
        onClose: () => { window.__closed += 1; },
        onSaved: () => { window.__saved = true; },
        ${onPick ? "onPick: (p) => { window.__picks.push(p); }," : ""}
      })
    );
  `;
}

// A VIRTUAL entry, resolved from the project root rather than written into
// a temp directory — esbuild resolves bare imports relative to the importing
// file, so an entry in /tmp cannot find react. The supabaseClient stub is
// here for the same class of reason: it reads import.meta.env, which does
// not exist under the iife format the browser needs.
//
// Note what is NOT stubbed: RecordInvoiceModal itself, and invoiceService's
// real module graph. The network is injected at the component's own seam
// (loadInvoices / save), which is the point — stub the edge, run the thing.
function plugins(opts) {
  return [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({
          path: a.path,
          namespace: "e",
        }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: entrySource(opts),
          loader: "jsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({
          path: a.path,
          namespace: "sb",
        }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents:
            "export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } };",
          loader: "js",
        }));
      },
    },
  ];
}

async function mount(page, opts) {
  await build({
    entryPoints: ["virtual-entry"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: bundle,
    jsx: "automatic",
    logLevel: "error",
    loader: { ".css": "text" },
    plugins: plugins(opts),
  });

  const js = readFileSync(bundle, "utf8");
  await page.setContent(`<!doctype html><html><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.waitForFunction(() => document.querySelector(".recinv"), null, {
    timeout: 5000,
  });
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

// --- the list ---------------------------------------------------------------

await mount(page, { paid: false, method: "cash" });

chk(
  "the invoices Square has are listed",
  (await page.locator(".recinv__row").count()) === 2,
  `${await page.locator(".recinv__row").count()} rows`
);

chk(
  "each row names the customer and the amount",
  (await page.locator(".recinv__row").first().innerText()).includes("Jeff Krueger") &&
    (await page.locator(".recinv__row").first().innerText()).includes("3,280")
);

chk(
  "and Square's own invoice number, which is what the customer's email shows",
  (await page.locator(".recinv__row").first().innerText()).includes("#000011")
);

chk(
  "THE POINT: a completed job offers the correction even while unpaid",
  (await page.locator("#recinv-method").count()) === 1,
  "Jeff's job sat completed-and-unpaid for days while the ACH settled, with " +
    "the method wrongly reading cash — gating this on paid hid the fix on " +
    "the only job that has ever needed it"
);

// A job still on the calendar has no payment method to correct — that gets
// decided at completion, on the completion screen.
await mount(page, { paid: false, method: null, status: "scheduled" });
chk(
  "THE POINT: a job that is not completed yet is NOT offered the correction",
  (await page.locator("#recinv-method").count()) === 0,
  "nothing has been recorded about how it will be paid, so there is no " +
    "correction to make"
);
await mount(page, { paid: false, method: "cash" });

// --- recording one ----------------------------------------------------------

await page.locator(".recinv__row").first().click();
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saves.length > 0, null, { timeout: 5000 });

const save = await page.evaluate(() => window.__saves[0]);

chk(
  "picking one and recording it saves that invoice",
  save.invoice.invoiceId === "inv_JEFF",
  JSON.stringify(save.invoice)
);

chk(
  "THE POINT: it does NOT claim the CRM emailed the customer",
  save.opts.emailed === false,
  `emailed was ${JSON.stringify(save.opts.emailed)}`
);

chk(
  "the public url and status come along",
  save.invoice.publicUrl === "https://squareup.com/pay/jeff" &&
    save.invoice.status === "PAID"
);

chk(
  "leaving the method untouched sends no change, paid or not",
  save.opts.paymentMethod === null,
  JSON.stringify(save.opts.paymentMethod)
);

// --- nothing picked ---------------------------------------------------------

await mount(page, { paid: false, method: "cash" });
await page.locator(".recinv__save").click();
chk(
  "recording without picking is refused rather than saving nothing",
  (await page.locator(".recinv__error").count()) === 1 &&
    (await page.evaluate(() => window.__saves.length)) === 0
);

// --- correcting the payment method -----------------------------------------

await mount(page, { paid: true, method: "cash", status: "completed" });

chk(
  "a paid job is offered the payment-method correction",
  (await page.locator("#recinv-method").count()) === 1
);

chk(
  "and it defaults to leaving the recorded method alone",
  (await page.locator("#recinv-method").inputValue()) === ""
);

chk(
  "THE POINT: 'Emailed invoice' is not offered as how a PAID job was paid",
  !(await page.locator("#recinv-method").innerHTML()).includes('value="invoice"'),
  "offering it would record a paid job as having collected nothing"
);

await page.locator(".recinv__row").first().click();
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saves.length > 0, null, { timeout: 5000 });

chk(
  "leaving the method untouched sends no change",
  (await page.evaluate(() => window.__saves[0].opts.paymentMethod)) === null
);

await mount(page, { paid: true, method: "cash", status: "completed" });
await page.locator(".recinv__row").first().click();
await page.selectOption("#recinv-method", "square");
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saves.length > 0, null, { timeout: 5000 });

chk(
  "THE POINT: picking a different method sends the correction",
  (await page.evaluate(() => window.__saves[0].opts.paymentMethod)) === "square",
  "this is the cash-vs-ACH mismatch against the 1099-K"
);

await mount(page, { paid: true, method: "cash", status: "completed" });
await page.locator(".recinv__row").first().click();
await page.selectOption("#recinv-method", "cash");
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saves.length > 0, null, { timeout: 5000 });

chk(
  "re-picking the method it already has sends no change",
  (await page.evaluate(() => window.__saves[0].opts.paymentMethod)) === null,
  "a no-op correction would write a 'corrected cash to cash' row into the history"
);

// --- saying what it did, or that it did nothing ------------------------------
//
// The silent close is what cost somebody twenty minutes: re-recording an
// invoice already on the job, with the method left on its "Leave as..."
// default, produced a modal that shut cleanly and changed nothing. Success
// and a broken save looked identical.

await mount(page, { paid: true, method: "cash", onJob: "inv_JEFF" });
await page.locator(".recinv__row").first().click();   // the same invoice
await page.locator(".recinv__save").click();
await page.waitForSelector(".recinv__nochange", { timeout: 5000 }).catch(() => {});

chk(
  "THE POINT: re-recording the same invoice with no method change says so",
  (await page.locator(".recinv__nochange").count()) === 1,
  "a silent close is indistinguishable from a broken save"
);

{
  const saved = await page.evaluate(() => window.__saved);
  const saves = await page.evaluate(() => window.__saves.length);
  chk(
    "and it stays open rather than closing on a no-op",
    saved !== true,
    `__saved=${JSON.stringify(saved)} saves=${saves}`
  );
}

chk(
  "and it names the method it is leaving alone, so the fix is obvious",
  (await page.locator(".recinv__nochange").innerText()).includes("Cash")
);

// Same invoice, but a real method change — that IS a change and must close.
await mount(page, { paid: true, method: "cash", onJob: "inv_JEFF" });
await page.locator(".recinv__row").first().click();
await page.selectOption("#recinv-method", "square");
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saved === true, null, { timeout: 5000 });

chk(
  "THE POINT: the same invoice WITH a method change is a real change",
  (await page.evaluate(() => window.__saves[0].opts.paymentMethod)) === "square" &&
    (await page.locator(".recinv__nochange").count()) === 0
);

// A different invoice is a change even with no method picked.
await mount(page, { paid: true, method: "cash", onJob: "inv_OTHER" });
await page.locator(".recinv__row").first().click();
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saved === true, null, { timeout: 5000 });

chk(
  "attaching a different invoice is a change, method or not",
  (await page.locator(".recinv__nochange").count()) === 0
);

// --- the manual fallback ----------------------------------------------------

await mount(page, { paid: false, method: "cash" });
await page.locator(".recinv__switch").click();
await page.fill("#recinv-id", "  inv_TYPED  ");
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__saves.length > 0, null, { timeout: 5000 });

const typed = await page.evaluate(() => window.__saves[0]);
chk("a pasted id can be recorded", typed.invoice.invoiceId === "inv_TYPED");
chk(
  "and is trimmed, because copying out of Square brings whitespace",
  !typed.invoice.invoiceId.includes(" ")
);
chk(
  "THE POINT: a pasted id does not claim an email either",
  typed.opts.emailed === false
);

// --- Square unreachable -----------------------------------------------------

await mount(page, { paid: false, method: "cash", failLoad: true });

chk(
  "THE POINT: Square being down falls back to the paste box",
  (await page.locator("#recinv-id").count()) === 1,
  "a dead screen here sends somebody back to the Supabase table editor"
);

chk(
  "and says why",
  (await page.locator(".recinv__warn").innerText()).includes("unreachable")
);

// --- handing the pick back instead of saving --------------------------------

await mount(page, { paid: false, method: "cash", onPick: true });
await page.locator(".recinv__row").nth(1).click();
await page.locator(".recinv__save").click();
await page.waitForFunction(() => window.__picks.length > 0, null, { timeout: 5000 });

chk(
  "with onPick the chosen invoice is handed back",
  (await page.evaluate(() => window.__picks[0].invoiceId)) === "inv_TRAN"
);

chk(
  "THE POINT: and nothing is saved, because the job is not completed yet",
  (await page.evaluate(() => window.__saves.length)) === 0,
  "attaching before completion leaves an invoice on a job that was never finished"
);

await browser.close();

// --- the completion flow, read as source ------------------------------------
//
// Mounting CompleteJob means standing up a router, the Square web payments
// form and a dozen services, which would test the harness. These are the
// three facts about it that this work depends on.

const page_src = readFileSync("src/pages/schedule/CompleteJob.jsx", "utf8");

chk(
  "completing with 'already_invoiced' opens the picker instead of completing",
  /if \(method === "already_invoiced"\) \{\s*setAttaching\(true\);\s*return;/.test(page_src)
);

chk(
  "THE POINT: 'already_invoiced' never reaches the database as a payment method",
  /ctx: \{ method: "invoice" \}/.test(page_src),
  "it is a UI choice, not a way money arrived"
);

chk(
  "attaching an existing invoice passes emailed: false",
  /emailed: false,\s*ctx: \{ method: "invoice" \}/.test(page_src)
);

chk(
  "creating a new one still passes emailed: true",
  /finalize\(\{ invoice, emailed: true \}\)/.test(page_src)
);

// --- the endpoint, read as source -------------------------------------------

const fn = readFileSync("netlify/functions/list-invoices.mjs", "utf8");

chk(
  "the endpoint is behind a login",
  /verifyUser\(req\)/.test(fn) && /401/.test(fn)
);

chk(
  "THE POINT: drafts are filtered out",
  /NOT_SENT\s*=\s*\["DRAFT"\]/.test(fn) && /!NOT_SENT\.includes/.test(fn),
  "a draft has been sent to nobody; offering one invites believing a customer was billed"
);

chk(
  "it agrees with get-invoice about what 'settled' means",
  readFileSync("netlify/functions/get-invoice.mjs", "utf8").match(
    /const SETTLED = \[(.*?)\]/s
  )?.[1] === fn.match(/const SETTLED = \[(.*?)\]/s)?.[1],
  "two endpoints disagreeing about PARTIALLY_PAID would be invisible"
);

chk(
  "a missing location id is named rather than returned as an empty list",
  /SQUARE_LOCATION_ID is not set/.test(fn)
);

// --- the nudge allowlist, pinned so it cannot quietly become a denylist ----
//
// verify/quote-close.sql asserts a closed quote is not chased, but SKIPS
// when db/quote-sender-name.sql is not in that chain — and a skipped
// assertion is one that cannot fail. This cannot skip.

const nudge = readFileSync("db/quote-sender-name.sql", "utf8");
chk(
  "THE POINT: sms_due_quote_nudges still filters on an ALLOWLIST of statuses",
  /status in \('sent',\s*'viewed'\)/.test(nudge),
  "turned into a denylist, a closed quote would start being chased again — " +
    "an allowlist is why 'closed' needed no change there at all"
);

console.log(bad === 0 ? "\nRecord-invoice holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
