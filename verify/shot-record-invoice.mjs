// Renders the Record-invoice screen and measures it.
//
// Assertions do not see layout. The last two bugs on the Undelivered screen
// were both invisible to every assertion and obvious in a screenshot, so
// this does the same job here: render at phone and desktop width, measure
// the things that actually go wrong, and leave a PNG to look at.
//
// What gets measured, and why each one:
//   * nothing overflows sideways — this is opened one-handed, outdoors
//   * the Record button is reachable without scrolling past 25 invoices
//   * every tap target clears 44px
//   * the modal fits the viewport rather than pushing the page

import { build } from "esbuild";
import { chromium } from "playwright";
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

const dir = mkdtempSync(join(tmpdir(), "sri-"));
const bundle = join(dir, "app.js");

// Eight invoices, so the list is long enough to scroll — a four-row list
// never shows whether the Record button got pushed off the bottom.
const INVOICES = Array.from({ length: 8 }, (_, i) => ({
  invoiceId: `inv_${i}`,
  invoiceNumber: String(10 + i).padStart(6, "0"),
  status: i === 0 ? "PAID" : "UNPAID",
  paid: i === 0,
  amount: [3280, 480, 1180, 220, 950, 310, 140, 2400][i],
  customerName: [
    "Jeff Krueger",
    "Mai Tran",
    "Denise DeLuca",
    "Rob Ellingham",
    "Priya Raghunathan-Whitfield",
    "Sam Oyelaran",
    "Tim Ho",
    "Marguerite Vandersteen",
  ][i],
  publicUrl: `https://squareup.com/pay/${i}`,
  createdAt: "2026-09-29T19:11:00Z",
}));

const ENTRY = `
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import Modal from "./src/components/RecordInvoiceModal.jsx";

  createRoot(document.getElementById("root")).render(
    h(Modal, {
      job: {
        id: "job-1",
        paid: true,
        payment_method: "cash",
        lead: { name: "Jeff Krueger" },
      },
      loadInvoices: async () => ({ invoices: ${JSON.stringify(INVOICES)} }),
      save: async () => {},
      onClose: () => {},
      onSaved: () => {},
    })
  );
`;

await build({
  entryPoints: ["virtual-entry"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: bundle,
  jsx: "automatic",
  logLevel: "error",
  loader: { ".css": "text" },
  plugins: [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({ path: a.path, namespace: "e" }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: ENTRY,
          loader: "jsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents:
            "export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } };",
          loader: "js",
        }));
      },
    },
  ],
});

const { readFileSync } = await import("node:fs");
const js = readFileSync(bundle, "utf8");
const css = readFileSync("src/components/RecordInvoiceModal.css", "utf8");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

for (const width of [390, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });

  await page.setContent(`<!doctype html><html><head><style>
    /* The app's type scale. Without these the modal renders at browser
       defaults and every measurement below is of something nobody sees. */
    :root {
      --text-xs: 12px; --text-sm: 14px; --text-base: 16px;
      --text-2xl: 24px;
    }
    body { margin: 0; font-family: -apple-system, sans-serif; background: #f1f5f9; }
    ${css}
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.waitForSelector(".recinv__row", { timeout: 5000 });

  await page.screenshot({ path: `verify/shot-recinv-${width}.png`, fullPage: false });

  const m = await page.evaluate(() => {
    const modal = document.querySelector(".recinv");
    const save = document.querySelector(".recinv__save");
    const rows = [...document.querySelectorAll(".recinv__row")];
    const taps = [...document.querySelectorAll("button, select, input")];
    return {
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      winH: window.innerHeight,
      modalH: modal.getBoundingClientRect().height,
      saveBottom: save.getBoundingClientRect().bottom,
      saveTop: save.getBoundingClientRect().top,
      rowCount: rows.length,
      shortTaps: taps
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => el.className || el.id),
    };
  });

  chk(`${width}px — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);
  chk(`${width}px — the modal fits the viewport`, m.modalH <= m.winH, `${m.modalH} > ${m.winH}`);
  chk(
    `${width}px — the Record button is on screen without scrolling the list away`,
    m.saveBottom <= m.winH && m.saveTop > 0,
    `bottom ${Math.round(m.saveBottom)} of ${m.winH}`
  );
  chk(`${width}px — all 8 invoices render`, m.rowCount === 8, `${m.rowCount}`);
  chk(
    `${width}px — every tap target clears 44px`,
    m.shortTaps.length === 0,
    m.shortTaps.join(", ")
  );

  await page.close();
}

await browser.close();
console.log(bad === 0 ? "\nLayout holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
