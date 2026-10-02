// The job history timeline, rendered and measured.
//
// Three things here are invisible to an assertion and were all wrong on
// Jeff Krueger's job:
//
//   * "Show 1 more change" sat flush against the Paperwork heading below it
//     and read as a control belonging to Paperwork;
//   * it offered to fold away exactly ONE row, which costs a button bigger
//     than the row it hides; and
//   * "Payment taken · Cash" sat directly above "Cash → Paid through
//     Square", which reads as the CRM contradicting itself rather than as a
//     correction.
//
// The first two are layout. The third is wording, but you only see the
// problem when the rows are next to each other.

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

const dir = mkdtempSync(join(tmpdir(), "sjh-"));
const bundle = join(dir, "app.js");

// Jeff's job, as it stands after the correction. Seven events: six
// milestones and one minor change, which is the shape that produced
// "Show 1 more change".
const EVENTS = [
  { id: 1, kind: "scheduled", to_status: "scheduled", amount: 1180,
    detail: "Sep 28, 2026 at 10:00 AM", created_at: "2026-09-25T17:16:00Z",
    actor: { full_name: "Jordan" } },
  { id: 2, kind: "price", amount: 3280, detail: "Quote was $1180.00",
    created_at: "2026-09-29T02:11:00Z", actor: { full_name: "Hayden" } },
  { id: 3, kind: "completed", from_status: "scheduled", to_status: "completed",
    payment_method: "cash", amount: 3280, created_at: "2026-09-30T03:20:00Z",
    actor: { full_name: "Jordan" } },
  { id: 4, kind: "payment", payment_method: "cash", amount: 3280,
    created_at: "2026-09-30T03:20:00Z", actor: { full_name: "Jordan" } },
  { id: 5, kind: "invoice", amount: 3280, to_status: "inv_A",
    detail: "Invoice recorded on the job", created_at: "2026-10-02T16:05:00Z",
    actor: { full_name: "Jordan" } },
  { id: 6, kind: "payment_method", from_status: "cash", to_status: "square",
    amount: 3280, created_at: "2026-10-02T16:05:00Z",
    actor: { full_name: "Jordan" } },
];

const ENTRY = `
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import JobHistory from "./src/components/JobHistory.jsx";

  createRoot(document.getElementById("root")).render(
    h("div", null,
      h(JobHistory, { jobId: "job-1" }),
      // Stands in for the Paperwork heading that follows the timeline on
      // the real job record. The button crowding it is the whole point.
      h("h2", { id: "next-section", style: { margin: 0, fontSize: "20px" } }, "Paperwork")
    )
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
          contents: ENTRY, loader: "jsx", resolveDir: process.cwd(),
        }));
        // Only the data source is stubbed. JobHistory itself runs for real.
        // leadService -> supabaseClient reads import.meta.env, which does not
        // exist under the iife format a browser needs. Without this the whole
        // module graph throws at init and nothing renders at all.
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents: "export const supabase = {};",
          loader: "js",
        }));
        b.onResolve({ filter: /services\/jobService$/ }, (a) => ({ path: a.path, namespace: "js" }));
        b.onLoad({ filter: /.*/, namespace: "js" }, () => ({
          contents: `export async function fetchJobEvents() { return ${JSON.stringify(EVENTS)}; }`,
          loader: "js",
        }));
      },
    },
  ],
});

const js = readFileSync(bundle, "utf8");
const css = readFileSync("src/components/JobHistory.css", "utf8");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

for (const width of [390, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(`<!doctype html><html><head><style>
    :root { --text-xs: 12px; --text-sm: 14px; --text-base: 16px; --text-2xl: 24px; }
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; background: #ffffff; }
    ${css}
  </style></head><body><div id="root"></div></body></html>`);
  page.on("pageerror", (e) => console.log(`      page error: ${e.message}`));
  await page.addScriptTag({ content: js });
  await page.waitForSelector(".jobhist__event", { timeout: 5000 });

  await page.screenshot({ path: `verify/shot-jobhist-${width}.png`, fullPage: true });

  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".jobhist__event")];
    const more = document.querySelector(".jobhist__more");
    const next = document.getElementById("next-section");
    const text = (sel) => document.querySelector(sel)?.innerText || "";
    return {
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      rowCount: rows.length,
      hasMore: Boolean(more),
      gapToNext: more
        ? next.getBoundingClientRect().top - more.getBoundingClientRect().bottom
        : next.getBoundingClientRect().top -
          rows[rows.length - 1].getBoundingClientRect().bottom,
      all: document.querySelector(".jobhist").innerText,
    };
  });

  chk(`${width}px — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);

  chk(
    `${width}px — THE POINT: one hidden change is shown, not folded behind a button`,
    m.hasMore === false && m.rowCount === 6,
    `more=${m.hasMore} rows=${m.rowCount}`
  );

  chk(
    `${width}px — the timeline is not crowding the next heading`,
    m.gapToNext >= 12,
    `${Math.round(m.gapToNext)}px of air`
  );

  chk(
    `${width}px — the correction reads in plain words, not raw column values`,
    m.all.includes("Cash → Paid through Square"),
    "raw 'cash → square' would sit under 'Payment taken · Cash' and look like a typo"
  );

  chk(
    `${width}px — THE POINT: the superseded payment row points forward instead of contradicting`,
    m.all.includes("later corrected"),
    "'Payment taken · Cash' above 'Cash → Paid through Square' reads as the CRM arguing with itself"
  );

  chk(
    `${width}px — and the superseded row still says what was originally believed`,
    m.all.includes("$3,280 · Cash"),
    "the snapshot must never be rewritten to agree with the correction"
  );

  await page.close();
}

await browser.close();
console.log(bad === 0 ? "\nHistory reads cleanly" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
