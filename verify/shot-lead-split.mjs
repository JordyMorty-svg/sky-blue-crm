// The lead page split into three, measured: node verify/shot-lead-split.mjs
//
// The lead page had grown into one scroll holding the edit form, the quotes
// panel, the whole text thread and the status history. This splits it:
//
//   /leads/:id                — the form, plus two buttons and a collapsed
//                               status history
//   /leads/:id/quotes         — quotes
//   /leads/:id/communication  — the number, the Call button, the thread and
//                               the whole timeline
//
// WHAT A SPLIT LIKE THIS GETS WRONG, and therefore what is measured:
//
//   * something is moved off the old page and onto NEITHER new one, so a
//     feature quietly disappears. The first section below is that check, and
//     it is the one this file exists for.
//   * the two buttons are uneven, or wrap, or miss 44px
//   * the collapsed history offers "Show (4)" and then shows a different
//     number of rows
//   * the Call button ends up somewhere you cannot reach with a thumb
//
// Leaves PNGs of all three pages at two widths.

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

const LEAD = {
  id: "lead-1",
  name: "Dana Reyes",
  phone: "4259513646",
  email: "dana.reyes@example.com",
  address: "1284 NW Harrison Blvd, Corvallis, OR 97330",
  status: "contacted",
  service: "residential-window-washing",
  property_type: "residential",
  estimate: 340,
  temperature: "warm",
  source: "door_knock",
  stories: 2,
  windows: 18,
  interior: false,
  notes: "",
  internal_notes: "",
  last_contacted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  contact_attempts: 4,
  appointment_at: null,
  creator: { full_name: "Hayden Mortensen" },
};

// Enough status history that collapsing it is obviously the right call.
const EVENTS = Array.from({ length: 9 }, (_, i) => ({
  id: i + 1,
  kind: "status",
  from_status: i === 0 ? null : "new",
  to_status: i === 0 ? "new" : "contacted",
  created_at: new Date(Date.now() - (9 - i) * 86400_000).toISOString(),
  actor: { full_name: "Hayden Mortensen" },
}));
// Two 'call' rows, which must NOT be counted or shown: contact_log owns
// outreach now and db/contact-history.sql copied the old ones across, so
// including them here would show every historic call twice.
EVENTS.push(
  { id: 50, kind: "call", from_status: "new", to_status: "contacted",
    created_at: new Date().toISOString(), actor: null },
  { id: 51, kind: "call", from_status: null, to_status: null,
    created_at: new Date().toISOString(), actor: null }
);

// Oldest first, which is the order contact_timeline() returns. It is a
// story, not a feed.
const TIMELINE = [
  { source: "lead", kind: "status", from_status: "new", to_status: "contacted",
    at: new Date(Date.now() - 5 * 86400_000).toISOString(), actor: "Hayden Mortensen", seq: 1 },
  { source: "contact", kind: "call_attempt", at: new Date(Date.now() - 2 * 86400_000).toISOString(),
    detail: "No answer", actor: null, seq: 2 },
  { source: "contact", kind: "text_in", at: new Date(Date.now() - 86400_000).toISOString(),
    detail: "looks good", actor: null, seq: 3 },
  { source: "contact", kind: "call", at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    detail: "4m 12s", from_status: "new", to_status: "contacted", actor: null, seq: 4 },
];

const THREAD = [
  { id: 1, direction: "out", kind: "quote", status: "sent", body: "Here's your quote for $340.",
    created_at: new Date(Date.now() - 4 * 3600_000).toISOString(), delivered_at: new Date().toISOString(),
    sent_by: null, error: null },
  { id: 2, direction: "in", kind: "inbound", status: "received", body: "Looks good, when can you come?",
    created_at: new Date(Date.now() - 3 * 3600_000).toISOString(), sent_by: null, error: null },
];

const dir = mkdtempSync(join(tmpdir(), "leadsplit-"));

const PAGES = {
  detail: { entry: "./src/pages/leads/LeadDetail.jsx", path: "/leads/lead-1" },
  quotes: { entry: "./src/pages/leads/LeadQuotes.jsx", path: "/leads/lead-1/quotes" },
  comms: { entry: "./src/pages/leads/LeadComms.jsx", path: "/leads/lead-1/communication" },
};

// Stubbed at the SERVICE boundary, not at fetch, so the pages are exercised
// exactly as they ship — RecordTabs, the collapse, describeEvent and the
// thread's own bubble logic all run for real.
const STUBS = (entry) => ({
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({ path: a.path, namespace: "e" }));
    b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
      contents: `
        import { createRoot } from "react-dom/client";
        import { createElement as h } from "react";
        import { MemoryRouter, Routes, Route } from "react-router-dom";
        import Page from "${entry}";
        createRoot(document.getElementById("root")).render(
          h(MemoryRouter, { initialEntries: ["/leads/lead-1"] },
            h(Routes, {}, h(Route, { path: "/leads/:id", element: h(Page) })))
        );
      `,
      loader: "jsx",
      resolveDir: process.cwd(),
    }));

    b.onResolve({ filter: /services\/leadService$/ }, (a) => ({ path: a.path, namespace: "ls" }));
    b.onLoad({ filter: /.*/, namespace: "ls" }, () => ({
      contents: `
        export const ALL_STATUSES = [
          { key: "new", label: "New" }, { key: "contacted", label: "Contacted" },
          { key: "quoted", label: "Quoted" }, { key: "booked", label: "Booked" },
          { key: "scheduled", label: "Scheduled" }, { key: "completed", label: "Completed" },
          { key: "lost", label: "Lost" }, { key: "archived", label: "Archived" }];
        export const LEADS_SETTABLE_STATUSES = ALL_STATUSES.slice(0, 5);
        export const LEAD_SOURCES = [{ key: "door_knock", label: "Door knock" }];
        export const SERVICE_TYPES = [{ key: "residential-window-washing", label: "Residential window washing" }];
        export const TEMPERATURES = [{ key: "warm", label: "Warm" }];
        export function serviceFor() { return { label: "Residential window washing" }; }
        export function sourceFor() { return { label: "Door knock" }; }
        export const QUO_WEB = "https://my.quo.com/";
        export function quoCallHref(p) { return p ? "openphone://dial?number=%2B1" + p + "&action=call" : null; }
        export function telHref(p) { return p ? "tel:" + p : null; }
        export function formatPhone(p) {
          const d = String(p || "").replace(/\D/g, "");
          return d.length === 10 ? "(" + d.slice(0,3) + ") " + d.slice(3,6) + "-" + d.slice(6) : String(p || "");
        }
        export function saveProblem() { return "Couldn't save."; }
        export async function fetchLead() { return ${JSON.stringify(LEAD)}; }
        export async function fetchLeadEvents() { return ${JSON.stringify(EVENTS)}; }
        export async function fetchAssignableOwners() { return []; }
        export async function updateLead(...a) { globalThis.__saves = (globalThis.__saves || []); globalThis.__saves.push(a); if (globalThis.__saveFails) throw new Error("Couldn't save that change. Try again."); }
        export async function deleteLead() {}
        export async function reassignLead() {}
        export function planFor() { return null; }
      `,
      loader: "js",
    }));

    b.onResolve({ filter: /services\/contactService$/ }, (a) => ({ path: a.path, namespace: "cs" }));
    b.onLoad({ filter: /.*/, namespace: "cs" }, () => ({
      contents: `
        export async function fetchContactTimeline() { return ${JSON.stringify(TIMELINE)}; }
        // The REAL one, re-exported rather than reimplemented. The page
        // under test should render with the function that ships; a stub of
        // it would make the screenshots agree with the stub.
        export { whenReached } from "./contactService.js";
        export function formatStamp(iso) {
          return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        }
        const K = { call: "Called", call_attempt: "Called, no answer", call_in: "They called",
                    call_missed: "Missed their call", text: "Texted", text_in: "They replied" };
        export function describeEvent(row, statusLabel) {
          const move = row.from_status && row.to_status
            ? statusLabel(row.from_status) + " \\u2192 " + statusLabel(row.to_status) : null;
          if (row.source === "contact") {
            const base = K[row.kind] || row.kind;
            return { title: move ? base + " \\u00b7 " + move : base, meta: row.detail || "", tone: "contact" };
          }
          return { title: move || "Status changed", meta: "", tone: "lead" };
        }
      `,
      loader: "js",
      // So the re-export above resolves to the real module next door.
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
          return { mine: row.direction === "out", who: row.direction === "out" ? "Automatic" : "Them",
                   automatic: row.direction === "out", state: row.delivered_at ? { label: "Delivered", tone: "good", detail: "" } : null };
        }
        export function deliveryState() { return null; }
      `,
      loader: "js",
    }));

    // Child components that are pages of their own concerns and do not
    // decide anything this file measures.
    b.onResolve({ filter: /components\/(AddressPicker|PlanPicker|AppointmentPicker|QuotesPanel)$/ },
      (a) => ({ path: a.path, namespace: "noop" }));
    b.onLoad({ filter: /.*/, namespace: "noop" }, () => ({
      contents: `export default function Noop() { return null; }`,
      loader: "jsx",
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

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const SHELL = (css, js) => `<!doctype html><html><head><style>
  :root {
    --text-xs: 12px; --text-sm: 14px; --text-md: 15px; --text-base: 16px;
    --text-lg: 18px; --text-xl: 20px; --text-2xl: 24px; --text-3xl: 30px;
  }
  body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; background: #ffffff; }
  ${css}
</style></head><body><div id="root"></div><script>${js}</script></body></html>`;

const measured = {};

for (const [name, cfg] of Object.entries(PAGES)) {
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
    plugins: [STUBS(cfg.entry)],
  });

  const js = readFileSync(out, "utf8");
  // index.css FIRST, and leaving it out is not a detail.
  //
  // It carries the global reset, and `box-sizing: border-box` with it.
  // Without that, `min-height: 44px` applies to the CONTENT box and the
  // padding is added on top — so the Call button measured 66px tall and
  // border-radius:999px rounded it into a ball. The app was fine; the
  // harness was lying, which is the worse of the two.
  const css =
    readFileSync("src/index.css", "utf8") +
    readFileSync("src/pages/leads/LeadDetail.css", "utf8") +
    readFileSync("src/pages/leads/LeadComms.css", "utf8") +
    readFileSync("src/components/RecordTabs.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8") +
    readFileSync("src/components/TextThread.css", "utf8");

  for (const width of [390, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    await page.setContent(SHELL(css, js));
    await page.waitForSelector(".detail", { timeout: 6000 });
    await page.screenshot({ path: `verify/shot-lead-${name}-${width}.png`, fullPage: true });

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
        toggle: document.querySelector(".detail__historytoggle")?.textContent?.trim() || null,
        timelineRows: document.querySelectorAll(".detail__timeline li").length,
        callText: document.querySelector(".callbar__call")?.textContent?.trim() || null,
        callHref: document.querySelector(".callbar__call")?.getAttribute("href") || null,
        callHeight: document.querySelector(".callbar__call")
          ? Math.round(r(document.querySelector(".callbar__call")).height) : null,
        commsRows: document.querySelectorAll(".comms__timeline li").length,
        bubbles: document.querySelectorAll(".thread__bubble").length,
        shortTaps: [...document.querySelectorAll("button, a")]
          .filter((el) => {
            const b = r(el);
            return b.height > 0 && b.height < 44 &&
              (el.classList.contains("rectabs__tab") ||
               el.classList.contains("comms__call") ||
               el.classList.contains("detail__historytoggle"));
          }).map((el) => el.className),
      };
    });

    measured[`${name}-${width}`] = m;
    chk(`${name} @${width} — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);
    chk(`${name} @${width} — the two buttons are there, in order`,
      m.tabLabels.join("|") === "Quotes|Communication", m.tabLabels.join("|"));
    chk(`${name} @${width} — ...and they are the same width`,
      Math.abs(m.tabWidths[0] - m.tabWidths[1]) <= 1, m.tabWidths.join(" vs "));
    if (m.callHeight != null) {
      chk(`${name} @${width} — the Call button is a pill, not a circle`,
        m.callHeight >= 44 && m.callHeight <= 52,
        `${m.callHeight}px tall — min-height on a content box ADDS the ` +
          `padding, so 44 + 11 + 11 becomes 66 and border-radius:999px ` +
          `rounds it into a ball`);
    }

    // The page you are on is marked, and only that one. Without it both
    // buttons look like somewhere else to go, and pressing the one you are
    // already on does nothing with no explanation.
    const expectCurrent =
      name === "quotes" ? ["Quotes"] : name === "comms" ? ["Communication"] : [];
    chk(`${name} @${width} — THE POINT: the page you are on is the one marked`,
      m.current.join("|") === expectCurrent.join("|"),
      `marked: [${m.current.join(", ")}], expected: [${expectCurrent.join(", ")}]`);

    chk(`${name} @${width} — ...and clear 44px`,
      m.shortTaps.length === 0 && m.tabHeights.every((h) => h >= 44),
      m.tabHeights.join(",") + " " + m.shortTaps.join(","));

    await page.close();
  }
}

console.log("\n-- nothing fell off the page --\n");

{
  // THE CHECK THIS FILE EXISTS FOR. Everything that used to be on the lead
  // page has to be on one of the three now. A split that loses a feature
  // looks exactly like a split that worked.
  const d = measured["detail-1100"];
  const c = measured["comms-1100"];

  chk("THE POINT: the thread moved to Communication and is not on the form",
    c.bubbles === 2 && d.bubbles === 0,
    `comms=${c.bubbles} form=${d.bubbles}`);

  chk("THE POINT: the Call button moved to Communication",
    c.callText === "Call" && !d.text.includes("\nCall\n"),
    `comms=${c.callText}`);

  chk("...and still goes through Quo, not the handset",
    /^openphone:\/\/dial/.test(c.callHref || ""), c.callHref);

  chk("THE POINT: \"last reached out\" moved, with the attempt count",
    /Last reached out/.test(c.text) && /4 attempts/.test(c.text) &&
      !/Last reached out/.test(d.text),
    "the line that stops a fifth call has to be beside the Call button");

  chk("the number is formatted the way it is read aloud",
    /\(425\) 951-3646/.test(c.text),
    "ten unbroken digits is a number you lose your place in");

  // Matched on the SHAPE, not on the word "today".
  //
  // The fixture is "three hours ago", so what that renders as depends on
  // what time the suite runs — at 1am it is correctly "yesterday". The
  // first version asserted "today at", which was a test that failed once a
  // day for a function that was working. The day arithmetic itself is
  // pinned properly in the whenReached section below, against fixed dates
  // and an injected clock; what matters here is that the page renders a
  // relative phrase rather than a raw timestamp.
  chk("...and reads as a phrase a person uses, not a raw date",
    /Last reached out (today at \d|yesterday|\d+ days ago|on \w{3} \d)/.test(c.text),
    (c.text.match(/Last reached out[^\n]*/) || [""])[0]);

  chk("THE POINT: the full history moved to Communication",
    c.commsRows === 4 && /Called/.test(c.text),
    `${c.commsRows} rows`);

  chk("the form no longer offers a link to a separate history page",
    !/See full history/.test(d.text));

  chk("the form kept the fields it is for",
    /Phone/.test(d.text) && /Address/.test(d.text) && /Estimate/.test(d.text));
}

console.log("\n-- there is a way to ring somebody from a desktop --\n");

{
  // THE BUG THIS SECTION EXISTS FOR.
  //
  // Quo publishes no API for placing a call, so the only route is one of
  // its apps, and `openphone://dial` is documented for the MOBILE apps
  // only. On a desktop without the Quo app registered as a handler, the
  // Call button does nothing at all — no dialler, no error, no call.
  //
  // It shipped that way with a comment in leadService.js claiming the
  // pages "also offer QUO_WEB as a plain link". They did not. Nothing
  // imported QUO_WEB, and the only way to find out was to press Call on a
  // laptop and watch nothing happen.
  const js = readFileSync(join(dir, "comms.js"), "utf8");
  const css =
    readFileSync("src/index.css", "utf8") +
    readFileSync("src/pages/leads/LeadDetail.css", "utf8") +
    readFileSync("src/pages/leads/LeadComms.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8") +
    readFileSync("src/components/RecordTabs.css", "utf8");

  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".callbar", { timeout: 6000 });

  // window.open is replaced rather than allowed: a real popup would open a
  // live Quo tab from a test run, and what is being measured is WHETHER it
  // is called and with what, not what Quo serves.
  //
  // navigator.clipboard is REPLACED rather than permitted, because a page
  // built with setContent has no origin and the Clipboard API is only
  // exposed in a secure context — it is undefined here, which is exactly
  // the older-browser case the component's catch exists for. Recording the
  // argument tests the contract that matters: what we hand the clipboard.
  await page.evaluate(() => {
    globalThis.__opened = [];
    globalThis.__copied = [];
    window.open = (...a) => { globalThis.__opened.push(a); return null; };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t) => { globalThis.__copied.push(t); return Promise.resolve(); } },
    });
  });

  const m0 = await page.evaluate(() => ({
    call: document.querySelector(".callbar__call")?.getAttribute("href") || null,
    web: document.querySelector(".callbar__web")?.textContent?.trim() || null,
    hint: document.querySelector(".callbar__hint")?.textContent?.trim() || "",
  }));

  chk("THE POINT: there is a second button beside Call",
    m0.web === "Copy & open Quo",
    `got ${JSON.stringify(m0.web)} — without it, pressing Call on a laptop ` +
      `does nothing and the feature looks broken`);

  chk("...and the page says so in words",
    /only works on a phone/i.test(m0.hint),
    m0.hint);

  chk("Call still goes to the Quo app on a phone",
    /^openphone:\/\/dial/.test(m0.call || ""), m0.call);

  await page.click(".callbar__web");
  await page.waitForTimeout(200);

  const m1 = await page.evaluate(() => ({
    opened: globalThis.__opened,
    clip: globalThis.__copied[0] ?? null,
    copies: globalThis.__copied.length,
    label: document.querySelector(".callbar__web")?.textContent?.trim(),
  }));

  chk("THE POINT: it opens Quo",
    m1.opened.length === 1 && /^https:\/\/my\./.test(m1.opened[0][0]),
    JSON.stringify(m1.opened));

  chk("...in a new tab, without handing it window.opener",
    String(m1.opened[0][2] || "").includes("noopener"),
    String(m1.opened[0][2]));

  chk("THE POINT: ...with the number already on the clipboard, in E.164",
    m1.clip === "+14259513646",
    `${JSON.stringify(m1.clip)} — the whole point is not having to read ` +
      `ten digits off one screen and type them into another`);

  chk("...and says it copied", /Copied/.test(m1.label || ""), m1.label);

  await page.screenshot({ path: "verify/shot-lead-callbar-1100.png", fullPage: true });
  await page.close();
}

{
  // Copying can fail — a denied permission, an older browser, an insecure
  // context. Quo must still open: arriving there with the number in your
  // head is half the job done; arriving nowhere is none of it.
  const js = readFileSync(join(dir, "comms.js"), "utf8");
  const css = readFileSync("src/index.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8");

  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".callbar__web", { timeout: 6000 });

  await page.evaluate(() => {
    globalThis.__opened = [];
    window.open = (...a) => { globalThis.__opened.push(a); return null; };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });

  await page.click(".callbar__web");
  await page.waitForTimeout(200);

  const opened = await page.evaluate(() => globalThis.__opened);
  chk("THE POINT: Quo opens even when the copy is refused",
    opened.length === 1,
    "a failed clipboard must not also swallow the navigation");

  await page.close();
}

console.log("\n-- leaving the form does not throw the edits away --\n");

{
  // THE BUG THE SPLIT BROUGHT BACK.
  //
  // The lead page is a form, and leaving it does not save it. Before the
  // split, the thing that navigated away mid-edit was "Send a quote", and
  // QuotesPanel's beforeSend was written to stop it. Quotes are a separate
  // page now, so that hook is gone from this page — and the two buttons at
  // the top do the exact same thing to the exact same edits.
  const js = readFileSync(join(dir, "detail.js"), "utf8");
  const css =
    readFileSync("src/index.css", "utf8") +
    readFileSync("src/pages/leads/LeadDetail.css", "utf8") +
    readFileSync("src/components/RecordTabs.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8");

  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".rectabs__tab", { timeout: 6000 });

  // Type a new number, the way somebody correcting a typo would.
  await page.fill('input[type="tel"]', "5415550199");
  await page.click('.rectabs__tab:not([aria-current])');
  await page.waitForFunction(() => (globalThis.__saves || []).length > 0, { timeout: 3000 })
    .catch(() => {});

  const saved = await page.evaluate(() => globalThis.__saves || []);
  chk("THE POINT: pressing a tab saves the form first",
    saved.length === 1 && JSON.stringify(saved[0]).includes("5415550199"),
    `${saved.length} saves — without this, typing a correction and pressing ` +
      `Communication throws it away silently`);

  await page.close();
}

{
  // And a save that FAILS must not navigate. Going somewhere else off a page
  // whose edits just failed to save is the same bug one step quieter.
  const js = readFileSync(join(dir, "detail.js"), "utf8");
  const css =
    readFileSync("src/index.css", "utf8") +
    readFileSync("src/pages/leads/LeadDetail.css", "utf8") +
    readFileSync("src/components/RecordTabs.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8");

  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".rectabs__tab", { timeout: 6000 });
  await page.evaluate(() => { globalThis.__saveFails = true; });

  await page.fill('input[type="tel"]', "5415550199");
  await page.click('.rectabs__tab:not([aria-current])');
  await page.waitForSelector(".rectabs__error", { timeout: 3000 }).catch(() => {});

  const m = await page.evaluate(() => ({
    stillHere: Boolean(document.querySelector('input[type="tel"]')),
    typed: document.querySelector('input[type="tel"]')?.value,
    err: document.querySelector(".rectabs__error")?.textContent?.trim() || null,
    stuck: document.querySelector(".rectabs__tab:not([aria-current])")?.disabled,
  }));

  chk("THE POINT: a failed save keeps you on the form, with what you typed",
    m.stillHere && m.typed === "5415550199", `typed=${m.typed}`);
  chk("...and says so where the button is", Boolean(m.err), String(m.err));
  chk("...and the buttons come back rather than staying on Saving…",
    m.stuck === false, `disabled=${m.stuck}`);

  await page.close();
}

console.log("\n-- which day was that --\n");

{
  // A PURE FUNCTION WITH AN INJECTED CLOCK, because the bug is about which
  // DAY it is and a screenshot taken at an arbitrary hour cannot see it.
  //
  // The old implementation divided the elapsed milliseconds by 86,400,000.
  // Every case below where the gap is under 24 hours but the date changed
  // came back as "today", which is how "Last reached out today at 11:00 PM"
  // appeared on a Tuesday morning.
  // contactService imports the browser Supabase client, so the module is
  // bundled with that stubbed — the same way verify/lead-status.mjs reaches
  // saveProblem. whenReached is pure; nothing here touches the network.
  const fnOut = join(dir, "contact-service.mjs");
  await build({
    entryPoints: ["src/services/contactService.js"],
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
  const { whenReached } = await import(fnOut);
  // FIXED DATES IN THE PAST, deliberately far from whatever day this runs.
  //
  // The first version used dates around "today", which meant the assertions
  // also passed when the function IGNORED the injected clock and read the
  // real one — they agreed by coincidence, and the suite would have gone red
  // on its own a day later. March is nobody's today.
  const at = (s) => new Date(s);

  chk("THE POINT: 11pm last night, read at 1am, is yesterday",
    whenReached(at("2026-03-14T23:00:00"), at("2026-03-15T01:00:00")) === "yesterday",
    whenReached(at("2026-03-14T23:00:00"), at("2026-03-15T01:00:00")) +
      " — two hours is also 8am to 10am on one morning; only the calendar " +
      "tells them apart");

  chk("...and 8am to 10am the same morning is still today",
    /^today at /.test(whenReached(at("2026-03-15T08:00:00"), at("2026-03-15T10:00:00"))),
    whenReached(at("2026-03-15T08:00:00"), at("2026-03-15T10:00:00")));

  chk("this morning reads as a time",
    whenReached(at("2026-03-15T15:14:00"), at("2026-03-15T21:00:00")) === "today at 3:14 PM",
    whenReached(at("2026-03-15T15:14:00"), at("2026-03-15T21:00:00")));

  chk("two days back counts days, not hours",
    whenReached(at("2026-03-13T23:30:00"), at("2026-03-15T00:30:00")) === "2 days ago",
    whenReached(at("2026-03-13T23:30:00"), at("2026-03-15T00:30:00")));

  chk("a month back gives the date",
    whenReached(at("2026-02-18T10:00:00"), at("2026-03-15T10:00:00")) === "on Feb 18, 2026",
    whenReached(at("2026-02-18T10:00:00"), at("2026-03-15T10:00:00")));

  chk("never contacted says nothing rather than Invalid Date",
    whenReached(null) === "" && whenReached(undefined) === "");
}

console.log("\n-- the collapsed status history --\n");

{
  const d = measured["detail-1100"];

  chk("THE POINT: status history starts shut",
    d.timelineRows === 0 && /^Show \(\d+\)$/.test(d.toggle || ""),
    `toggle=${d.toggle} rows=${d.timelineRows}`);

  // The count and the rows come from one list on purpose. They were two
  // once, and the button offered four rows and then showed two.
  chk("THE POINT: the count on the button excludes the 'call' rows",
    d.toggle === "Show (9)",
    `${d.toggle} — contact_log owns outreach now, so a 'call' lead_event ` +
      `would show every historic call twice`);
}

console.log("\n-- opening it --\n");

{
  const out = join(dir, "detail.js");
  const js = readFileSync(out, "utf8");
  const css =
    readFileSync("src/index.css", "utf8") +
    readFileSync("src/pages/leads/LeadDetail.css", "utf8") +
    readFileSync("src/components/RecordTabs.css", "utf8") +
    readFileSync("src/components/CallBar.css", "utf8");

  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  await page.setContent(SHELL(css, js));
  await page.waitForSelector(".detail__historytoggle", { timeout: 6000 });
  await page.click(".detail__historytoggle");
  await page.waitForSelector(".detail__timeline li", { timeout: 3000 });

  const m = await page.evaluate(() => ({
    rows: document.querySelectorAll(".detail__timeline li").length,
    toggle: document.querySelector(".detail__historytoggle")?.textContent?.trim(),
    expanded: document.querySelector(".detail__historytoggle")?.getAttribute("aria-expanded"),
  }));

  chk("THE POINT: it shows exactly as many rows as the button promised",
    m.rows === 9, `${m.rows} rows for a button that said "Show (9)"`);
  chk("...and the button becomes Hide", m.toggle === "Hide", m.toggle);
  chk("...and says so to a screen reader", m.expanded === "true", m.expanded);

  await page.screenshot({ path: "verify/shot-lead-detail-open-1100.png", fullPage: true });
  await page.close();
}

await browser.close();

console.log(bad === 0
  ? "\nall ok — three pages, nothing lost between them\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
