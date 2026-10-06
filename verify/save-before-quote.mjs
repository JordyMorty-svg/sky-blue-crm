// Saving the lead before the quote modal opens.
//
// The trap this closes
// --------------------
// "Save changes" on the lead page saves AND navigates back to the board. So
// there was no way to keep the edits you had just made and then send a quote
// from the same screen — the only orders available were save-and-leave, or
// send-and-lose-your-typing. Hayden did the second repeatedly.
//
// Worth being precise about what was and was not broken, because the fix
// depends on it:
//
//   * the QUOTE was always right. suggestedAmount reads `form`, not the
//     saved row, so the customer got the number that was on screen.
//   * the LEAD RECORD was not. Everything typed was dropped on navigation.
//
// So this is about the record catching up with the quote, not about
// mis-priced quotes — and the assertions say so, because a future reader
// who believes quotes were going out wrong will "fix" the wrong thing.

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

const dir = mkdtempSync(join(tmpdir(), "sbq-"));
const bundle = join(dir, "app.js");

function entry({ failSave }) {
  return `
    import { createRoot } from "react-dom/client";
    import { createElement as h } from "react";
    import QuotesPanel from "./src/components/QuotesPanel.jsx";

    window.__order = [];

    createRoot(document.getElementById("root")).render(
      h(QuotesPanel, {
        leadId: "lead-1",
        customerName: "Jeff Krueger",
        customerPhone: "+15555550100",
        address: "1 Test St",
        suggestedAmount: 1800,
        beforeSend: async () => {
          window.__order.push("save");
          ${failSave ? 'throw new Error("Could not save. Try again.");' : ""}
        },
      })
    );
  `;
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
    plugins: [
      {
        name: "entry",
        setup(b) {
          b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({ path: a.path, namespace: "e" }));
          b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
            contents: entry(opts), loader: "jsx", resolveDir: process.cwd(),
          }));
          // Only the network. The panel and the modal both run for real.
          b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
          b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
            contents: `
              const res = { data: [], error: null };
              const chain = {
                select: () => chain, eq: () => chain, order: () => chain,
                is: () => chain, in: () => chain,
                then: (f) => Promise.resolve(res).then(f),
              };
              export const supabase = {
                from: () => chain,
                rpc: async () => { window.__order.push("rpc"); return res; },
                auth: { getSession: async () => ({ data: { session: null } }) },
              };`,
            loader: "js",
          }));
        },
      },
    ],
  });

  const js = readFileSync(bundle, "utf8");
  await page.setContent(`<!doctype html><html><head><style>
    :root { --text-xs:12px; --text-sm:14px; --text-base:16px; --text-2xl:24px; }
    body { margin:0; font-family:-apple-system, sans-serif; }
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.waitForSelector(".quotes__send", { timeout: 5000 });
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

// --- the happy path ---------------------------------------------------------

await mount(page, { failSave: false });
// Cleared AFTER mounting: the panel loads its own quote list on mount, and
// that call was being counted as though it came from the button.
await page.evaluate(() => { window.__order = []; });
await page.locator(".quotes__send").click();
await page.waitForSelector(".quotem", { timeout: 5000 }).catch(() => {});

chk(
  "THE POINT: pressing Send a quote saves the page first",
  (await page.evaluate(() => window.__order))[0] === "save",
  JSON.stringify(await page.evaluate(() => window.__order))
);

chk(
  "and then opens the quote modal",
  (await page.locator(".quotem").count()) === 1
);

// --- the save fails ---------------------------------------------------------

await mount(page, { failSave: true });
await page.evaluate(() => { window.__order = []; });
await page.locator(".quotes__send").click();
await page.waitForSelector(".quotes__preperr", { timeout: 5000 }).catch(() => {});

chk(
  "THE POINT: a failed save does NOT open the modal",
  (await page.locator(".quotem").count()) === 0,
  "sending a quote off a page whose edits are about to vanish is the same " +
    "bug, just quieter"
);

chk(
  "and it says what went wrong, where the button is",
  (await page.locator(".quotes__preperr").count()) === 1 &&
    (await page.locator(".quotes__preperr").innerText()).includes("save")
);

chk(
  "the button comes back rather than staying stuck on Saving…",
  (await page.locator(".quotes__send").isDisabled()) === false
);

await browser.close();

// --- read as source ---------------------------------------------------------

const lead = readFileSync("src/pages/leads/LeadDetail.jsx", "utf8");

// THE LEAD PAGE NO LONGER PASSES beforeSend, and this check changed with it.
//
// Quotes moved to /leads/:id/quotes when the lead page was split up, so the
// panel is no longer rendered under the form and there are no unsaved edits
// for it to rescue. The hazard did not go away, though — it moved. Leaving
// the form by pressing Quotes or Communication throws the edits away in
// exactly the same manner, so the same save now hangs off RecordTabs.
//
// verify/shot-lead-split.mjs drives that one for real, with a browser.
chk(
  "the lead page still has exactly one save, and hands it to the tabs",
  /beforeLeave=\{persist\}/.test(lead) && !/beforeSend=\{persist\}/.test(lead),
  "the lost-edits bug moved from Send a quote to the two buttons at the top"
);

chk(
  "THE POINT: there is exactly ONE copy of the save payload",
  (lead.match(/updateLead\(id, \{/g) || []).length === 1,
  "the payload is an explicit column list, so a second copy would quietly " +
    "stop saving whichever field was added last"
);

chk(
  "and persist() does not navigate — only handleSave does",
  /async function persist\(\) \{\s*await updateLead/.test(lead) &&
    /await persist\(\);\s*navigate\("\/leads"\)/.test(lead),
  "a save that navigates cannot be used before opening a modal on the same page"
);

const panel = readFileSync("src/components/QuotesPanel.jsx", "utf8");

chk(
  "a panel given no beforeSend still opens straight away",
  /if \(!beforeSend\) \{\s*setOpen\(true\);\s*return;\s*\}/.test(panel),
  "the customer page passes none, and must not be made to wait on nothing"
);

console.log(bad === 0 ? "\nSave-before-quote holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
