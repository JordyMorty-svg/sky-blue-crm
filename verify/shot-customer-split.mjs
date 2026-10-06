// The customer page split into three: node verify/shot-customer-split.mjs
//
// The twin of verify/shot-lead-split.mjs, and a separate file rather than a
// parameter on that one because the two pages share RecordTabs and almost
// nothing else: different header, different data shape, a dropdown Actions
// menu instead of a save button, and a job history that deliberately STAYS
// on the main page.
//
//   /customers/:id                — contact details, the two toggles, the
//                                   stat tiles, two buttons, job history
//   /customers/:id/quotes         — quotes
//   /customers/:id/communication  — the number, the Call button, the thread
//                                   and the whole timeline
//
// WHAT A SPLIT LIKE THIS GETS WRONG, and so what is measured:
//
//   * something moves off the old page and onto NEITHER new one
//   * "Send a quote" in the Actions menu silently becomes a three-tap
//     journey instead of one — the menu item still exists and still looks
//     right, which is why only a click can tell you
//   * the two pages end up suggesting DIFFERENT prices for the same
//     customer, because the derivation got copied
//   * job history goes missing from the main page, which is the thing most
//     people open a customer to look at

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

const CUSTOMER = {
  id: "cust-1",
  name: "Sherry Hanning",
  phone: "5412316649",
  email: "sherryhanning1@gmail.com",
  address: "337 N 12th St, Philomath, OR 97370, USA",
  property_type: "residential",
  service_plan: "one_time",
  email_opt_out: false,
  reviewed_at: null,
  last_contacted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  contact_attempts: 2,
};

const JOBS = [
  {
    id: "job-1",
    status: "scheduled",
    starts_at: "2026-10-09T13:00:00",
    price: 349,
    final_price: null,
    service_plan: "one_time",
    visit_number: 1,
    duration_hours: 3,
    services: ["residential-window-washing"],
  },
];

const TIMELINE = [
  { source: "contact", kind: "call_attempt", at: new Date(Date.now() - 2 * 86400_000).toISOString(),
    detail: "No answer", actor: null, seq: 1 },
  { source: "contact", kind: "call", at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    detail: "4m 12s", actor: null, seq: 2 },
];

const THREAD = [
  { id: 1, direction: "in", kind: "inbound", status: "received",
    body: "Hi, is Friday still OK?",
    created_at: new Date(Date.now() - 3600_000).toISOString(), sent_by: null, error: null },
];

const dir = mkdtempSync(join(tmpdir(), "custsplit-"));

const PAGES = {
  detail: "./src/pages/customers/CustomerDetail.jsx",
  quotes: "./src/pages/customers/CustomerQuotes.jsx",
  comms: "./src/pages/customers/CustomerComms.jsx",
};

// `entryState` is what the router hands the page. The quotes page reads
// state.send to decide whether to open the modal on arrival, which is the
// whole of the "Send a quote" shortcut and cannot be checked any other way.
const STUBS = (entry, entryState = null, probeDestination = false) => ({
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({ path: a.path, namespace: "e" }));
    b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
      contents: `
        import { createRoot } from "react-dom/client";
        import { createElement as h } from "react";
        import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
        import Page from "${entry}";

        // Stands in for the quotes page so a click on "Send a quote" can be
        // FOLLOWED rather than merely observed to have left. It writes the
        // path and the state it was handed into the DOM, which is the only
        // way to tell "navigated" from "navigated with send: true" — and
        // those two differ by whether the modal opens on arrival.
        function Probe() {
          const loc = useLocation();
          return h("pre", { id: "probe" },
            JSON.stringify({ path: loc.pathname, state: loc.state }));
        }

        createRoot(document.getElementById("root")).render(
          h(MemoryRouter, {
            initialEntries: [{ pathname: "/customers/cust-1", state: ${JSON.stringify(entryState)} }],
          }, h(Routes, {},
            h(Route, { path: "/customers/:id", element: h(Page) }),
            ${probeDestination
              ? 'h(Route, { path: "/customers/:id/quotes", element: h(Probe) })'
              : "null"}
          ))
        );
      `,
      loader: "jsx",
      resolveDir: process.cwd(),
    }));

    b.onResolve({ filter: /services\/customerService$/ }, (a) => ({ path: a.path, namespace: "cu" }));
    b.onLoad({ filter: /.*/, namespace: "cu" }, () => ({
      contents: `
        // The REAL suggestedQuoteFor, re-exported rather than stubbed: the
        // point of extracting it was that both pages use one derivation, and
        // a stub would let them diverge while this suite stayed green.
        export { suggestedQuoteFor } from "./customerService.js";
        export async function fetchCustomer() {
          return { customer: ${JSON.stringify(CUSTOMER)}, jobs: ${JSON.stringify(JOBS)}, leadNotes: null };
        }
        export async function updateCustomer() {}
        export async function deleteCustomer() {}
      `,
      loader: "js",
      resolveDir: join(process.cwd(), "src/services"),
    }));

    b.onResolve({ filter: /services\/jobService$/ }, (a) => ({ path: a.path, namespace: "jo" }));
    b.onLoad({ filter: /.*/, namespace: "jo" }, () => ({
      contents: `
        export async function fetchNextVisit() { return null; }
        export async function ensureNextVisit() { return null; }
        export const RECURRING_LEAD_TIME_DAYS = 14;
        export const SERVICE_LABELS = { "residential-window-washing": "Residential window washing" };
      `,
      loader: "js",
    }));

    b.onResolve({ filter: /services\/contactService$/ }, (a) => ({ path: a.path, namespace: "co" }));
    b.onLoad({ filter: /.*/, namespace: "co" }, () => ({
      contents: `
        export { whenReached } from "./contactService.js";
        export async function fetchContactTimeline() { return ${JSON.stringify(TIMELINE)}; }
        export function formatStamp(iso) {
          return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        }
        const K = { call: "Called", call_attempt: "Called, no answer" };
        export function describeEvent(row) {
          return { title: K[row.kind] || row.kind, meta: row.detail || "", tone: "contact" };
        }
      `,
      loader: "js",
      resolveDir: join(process.cwd(), "src/services"),
    }));

    b.onResolve({ filter: /services\/textService$/ }, (a) => ({ path: a.path, namespace: "ts" }));
    b.onLoad({ filter: /.*/, namespace: "ts" }, () => ({
      contents: `
        export async function fetchThread() { return ${JSON.stringify(THREAD)}; }
        export async function sendText() { return { ok: true }; }
        export function segmentsFor(t) { return { segments: 1, length: String(t||"").length }; }
        export function prettyPhone(p) { return p; }
        export function describeMessage(row) {
          return { mine: row.direction === "out", who: "Them", automatic: false, state: null };
        }
        export function deliveryState() { return null; }
      `,
      loader: "js",
    }));

    b.onResolve({ filter: /services\/followUpService$/ }, (a) => ({ path: a.path, namespace: "fu" }));
    b.onLoad({ filter: /.*/, namespace: "fu" }, () => ({
      contents: `export async function setEmailOptOut() {} export async function setCustomerReviewed() {}`,
      loader: "js",
    }));

    // QuotesPanel is NOT stubbed on the quotes page: whether the modal opens
    // on arrival is the thing being measured, and it is the panel that opens
    // it. Everything else is a page of its own concerns.
    b.onResolve({ filter: /components\/(AddressPicker|JobPlanTag|PlanPicker|AppointmentPicker)$/ },
      (a) => ({ path: a.path, namespace: "noop" }));
    b.onLoad({ filter: /.*/, namespace: "noop" }, () => ({
      contents: `export default function Noop() { return null; }`,
      loader: "jsx",
    }));

    b.onResolve({ filter: /services\/quoteService$/ }, (a) => ({ path: a.path, namespace: "qs" }));
    b.onLoad({ filter: /.*/, namespace: "qs" }, () => ({
      contents: `
        export const SERVICE_LABELS = {};
        export const SERVICE_OPTIONS = [
          { key: "residential-window-washing", label: "Residential window washing" },
        ];
        export const CLOSE_REASONS = [];
        // Never reached: the suite opens the modal and looks at it, and
        // never presses Send. Throwing rather than resolving means a test
        // that accidentally DOES press it fails loudly instead of quietly
        // pretending a quote went to a customer.
        export async function sendQuote() { throw new Error("verify: sendQuote must not be called"); }
        export async function fetchQuotes() { return []; }
        export function deletable() { return false; }
        export function reopenable() { return false; }
        export function closeReason() { return ""; }
        export function describeLoadError() { return ""; }
        export function money(n) { return "$" + n; }
        export function quoteState() { return {}; }
        export function shortDate() { return ""; }
        export function smsHref() { return null; }
        export function viewSummary() { return ""; }
        export function smsText() { return ""; }
        export async function deleteQuote() {}
        export async function closeQuote() {}
        export async function reopenQuote() {}
      `,
      loader: "js",
    }));

    b.onResolve({ filter: /services\/deliveryService$/ }, (a) => ({ path: a.path, namespace: "ds" }));
    b.onLoad({ filter: /.*/, namespace: "ds" }, () => ({
      contents: `
        export async function fetchQuoteDelivery() { return {}; }
        export function failureLabel() { return ""; }
        export function whatToDo() { return ""; }
      `,
      loader: "js",
    }));

    b.onResolve({ filter: /context\/useAuth$/ }, (a) => ({ path: a.path, namespace: "auth" }));
    b.onLoad({ filter: /.*/, namespace: "auth" }, () => ({
      contents: `export function useAuth() { return { role: "owner", user: { id: "u1" } }; }`,
      loader: "js",
    }));

    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
    b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
      contents: `export const supabase = {
        auth: { getSession: async () => ({ data: { session: null } }) },
        rpc: async () => ({ data: [], error: null }),
      };`,
      loader: "js",
    }));
  },
});

const CSS = () =>
  readFileSync("src/index.css", "utf8") +
  readFileSync("src/pages/customers/Customers.css", "utf8") +
  readFileSync("src/pages/leads/LeadComms.css", "utf8") +
  readFileSync("src/components/RecordTabs.css", "utf8") +
  readFileSync("src/components/RecordMenu.css", "utf8") +
  readFileSync("src/components/QuotesPanel.css", "utf8") +
  readFileSync("src/components/TextThread.css", "utf8");

const SHELL = (css, js) => `<!doctype html><html><head><style>
  :root {
    --text-xs: 12px; --text-sm: 14px; --text-md: 15px; --text-base: 16px;
    --text-lg: 18px; --text-xl: 20px; --text-2xl: 24px; --text-3xl: 30px;
  }
  body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; background: #ffffff; }
  ${css}
</style></head><body><div id="root"></div><script>${js}</script></body></html>`;

async function bundle(name, entry, state = null, probeDestination = false) {
  const out = join(dir, `${name}.js`);
  await build({
    entryPoints: ["virtual-entry"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: out,
    jsx: "automatic",
    logLevel: "error",
    loader: { ".css": "text" },
    plugins: [STUBS(entry, state, probeDestination)],
  });
  return readFileSync(out, "utf8");
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const css = CSS();
const measured = {};

for (const [name, entry] of Object.entries(PAGES)) {
  const js = await bundle(name, entry);

  for (const width of [390, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    await page.setContent(SHELL(css, js));
    await page.waitForSelector(".custdetail", { timeout: 6000 });
    await page.screenshot({ path: `verify/shot-customer-${name}-${width}.png`, fullPage: true });

    const m = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".rectabs__tab")];
      const r = (el) => el.getBoundingClientRect();
      return {
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
        text: document.body.innerText,
        tabLabels: tabs.map((t) => t.textContent.trim()),
        tabWidths: tabs.map((t) => Math.round(r(t).width)),
        tabHeights: tabs.map((t) => Math.round(r(t).height)),
        current: tabs.filter((t) => t.getAttribute("aria-current") === "page")
          .map((t) => t.textContent.trim()),
        bubbles: document.querySelectorAll(".thread__bubble").length,
        quotesPanel: document.querySelectorAll(".quotes").length,
        callHref: document.querySelector(".comms__call")?.getAttribute("href") || null,
        callHeight: document.querySelector(".comms__call")
          ? Math.round(r(document.querySelector(".comms__call")).height) : null,
        commsRows: document.querySelectorAll(".comms__timeline li").length,
      };
    });

    measured[`${name}-${width}`] = m;

    chk(`${name} @${width} — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);
    chk(`${name} @${width} — the two buttons are there, in order`,
      m.tabLabels.join("|") === "Quotes|Communication", m.tabLabels.join("|"));
    chk(`${name} @${width} — ...same width, 44px tall`,
      Math.abs(m.tabWidths[0] - m.tabWidths[1]) <= 1 && m.tabHeights.every((h) => h >= 44),
      `${m.tabWidths.join(" vs ")} / ${m.tabHeights.join(",")}`);

    const expect = name === "quotes" ? ["Quotes"] : name === "comms" ? ["Communication"] : [];
    chk(`${name} @${width} — the page you are on is the one marked`,
      m.current.join("|") === expect.join("|"), `[${m.current.join(", ")}]`);

    if (m.callHeight != null) {
      chk(`${name} @${width} — the Call button is a pill, not a circle`,
        m.callHeight >= 44 && m.callHeight <= 52, `${m.callHeight}px`);
    }

    await page.close();
  }
}

console.log("\n-- nothing fell off the customer page --\n");

{
  const d = measured["detail-1100"];
  const c = measured["comms-1100"];
  const q = measured["quotes-1100"];

  chk("THE POINT: the thread moved to Communication and is off the customer page",
    c.bubbles === 1 && d.bubbles === 0, `comms=${c.bubbles} customer=${d.bubbles}`);

  chk("THE POINT: quotes moved to their own page and are off the customer page",
    q.quotesPanel === 1 && d.quotesPanel === 0,
    `quotes=${q.quotesPanel} customer=${d.quotesPanel}`);

  chk("THE POINT: job history STAYED on the customer page",
    /Job history/.test(d.text),
    "Jordan's call — it is the thing most people open a customer to look at");

  chk("...and the stat tiles stayed with it",
    /Visits completed/.test(d.text) && /Lifetime value/.test(d.text));

  // The apostrophe is &rsquo; in the markup and renders as U+2019, not as
  // an ASCII quote. Matched either way rather than pasting a character that
  // is invisible to anybody reading this file.
  chk("...and the two email toggles stayed",
    /Don.t send follow-up emails/.test(d.text) &&
      /Already left a Google review/.test(d.text),
    d.text.split("\n").filter((l) => /follow-up|review/i.test(l)).join(" | "));

  chk("the Call button moved to Communication, still through Quo",
    /^openphone:\/\/dial/.test(c.callHref || ""), c.callHref);

  chk("\"last reached out\" moved, with the attempt count",
    /Last reached out/.test(c.text) && /2 attempts/.test(c.text) &&
      !/Last reached out/.test(d.text));

  chk("the number is formatted the way it is read aloud",
    /\(541\) 231-6649/.test(c.text));

  chk("the full timeline is on Communication", c.commsRows === 2, `${c.commsRows} rows`);
}

console.log("\n-- Send a quote is still one tap --\n");

{
  // THE CHECK THIS SECTION EXISTS FOR.
  //
  // Moving quotes to their own page could easily have turned the Actions
  // menu item into a journey: open the menu, land on a page, find the
  // button, press it. The menu item would still be there and still be
  // spelled the same, which is exactly why only a click can tell you.
  const js = await bundle("detail-nav", PAGES.detail, null, true);
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".recmenu__button", { timeout: 6000 });

  await page.click(".recmenu__button");
  await page.waitForSelector(".recmenu__item", { timeout: 3000 });

  const items = await page.$$eval(".recmenu__item", (els) =>
    els.map((e) => e.textContent.trim())
  );
  chk("the Actions menu still offers Send a quote", items.includes("Send a quote"), items.join(", "));

  // The page renders at /customers/cust-1 under a MemoryRouter with one
  // route, so navigating away unmounts it. That unmount IS the signal: the
  // menu item navigated rather than opening a modal in place.
  await page.click('.recmenu__item:has-text("Send a quote")');
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => {
    const probe = document.querySelector("#probe");
    return {
      gone: !document.querySelector(".custdetail"),
      landed: probe ? JSON.parse(probe.textContent) : null,
    };
  });

  chk("THE POINT: it navigates to the quotes page rather than opening in place",
    after.gone && after.landed?.path === "/customers/cust-1/quotes",
    `landed on ${after.landed?.path ?? "nowhere"} — still on the customer ` +
      `page means the modal was opened here instead`);

  // The state is the whole shortcut. Navigating WITHOUT it is a change
  // nothing else can see: the menu item still works, the page still loads,
  // and the one-tap action has quietly become three.
  chk("THE POINT: ...carrying the instruction to open the modal on arrival",
    after.landed?.state?.send === true,
    `state = ${JSON.stringify(after.landed?.state)}`);

  await page.close();
}

{
  // And the other half: arriving with { send: true } opens the modal, so
  // the menu item is still ONE tap end to end.
  const js = await bundle("quotes-send", PAGES.quotes, { send: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".custdetail", { timeout: 6000 });
  await page.waitForTimeout(400);

  const opened = await page.evaluate(() =>
    document.body.innerText.includes("Send a quote") &&
    Boolean(document.querySelector("input, textarea, select"))
  );
  chk("THE POINT: arriving from the menu opens the quote modal",
    opened,
    "without this the menu item costs three taps where it used to cost one");

  await page.screenshot({ path: "verify/shot-customer-quotes-send-1100.png", fullPage: true });
  await page.close();

  // And arriving WITHOUT that state does not.
  const js2 = await bundle("quotes-plain", PAGES.quotes);
  const page2 = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page2.setContent(SHELL(css, js2));
  await page2.waitForSelector(".custdetail", { timeout: 6000 });
  await page2.waitForTimeout(400);

  const plain = await page2.evaluate(() =>
    Boolean(document.querySelector("input, textarea, select"))
  );
  chk("...and arriving by the Quotes button does not",
    !plain,
    "a modal that opens itself every time you look at the page is a trap");

  await page2.close();
}

console.log("\n-- one answer to \"what should we quote them\" --\n");

{
  // The derivation moved into customerService so BOTH pages use it. A copy
  // on either page would be a second answer, and the one nobody updated
  // would be the one somebody sent.
  const fnOut = join(dir, "customer-service.mjs");
  await build({
    entryPoints: ["src/services/customerService.js"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: fnOut,
    logLevel: "warning",
    plugins: [{
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb2" }));
        b.onLoad({ filter: /.*/, namespace: "sb2" }, () => ({
          contents: "export const supabase = {};", loader: "js",
        }));
      },
    }],
  });
  const { suggestedQuoteFor } = await import(fnOut);

  chk("a one-time customer is quoted what they last paid",
    suggestedQuoteFor(
      { property_type: "residential", service_plan: "one_time" },
      [{ status: "completed", final_price: 349, price: 300 }]
    ) === 349,
    "final_price beats price — one is what they were billed, the other what " +
      "they were quoted");

  chk("...falling back to the quoted price when nothing was billed",
    suggestedQuoteFor({ service_plan: "one_time" },
      [{ status: "completed", final_price: null, price: 300 }]) === 300);

  chk("THE POINT: a brand new customer gets a blank box, not a zero",
    suggestedQuoteFor({ service_plan: "one_time" }, []) === null,
    "an accidental 0 in front of a price gets sent; a blank gets filled in");

  chk("...and a job that completed for nothing is not a price",
    suggestedQuoteFor({ service_plan: "one_time" },
      [{ status: "completed", final_price: 0, price: 0 }]) === null);

  chk("...nor is a NaN",
    suggestedQuoteFor({ service_plan: "one_time" },
      [{ status: "completed", final_price: "free" }]) === null);

  chk("a customer with a real next visit on record is not projected at",
    suggestedQuoteFor(
      { property_type: "residential", service_plan: "quarterly" },
      [{ status: "scheduled", starts_at: "2026-10-09T13:00:00", price: 349, visit_number: 1 }],
      { id: "v1" }
    ) === null,
    "the projection is for plan customers who have no due date yet; with one " +
      "on record there is nothing to guess");

  chk("it survives being handed nothing at all",
    suggestedQuoteFor(null, null) === null && suggestedQuoteFor(undefined) === null);
}

await browser.close();

console.log(bad === 0
  ? "\nall ok — three pages, nothing lost, and Send a quote is still one tap\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
