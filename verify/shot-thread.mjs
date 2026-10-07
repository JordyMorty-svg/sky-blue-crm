// Renders the text thread and measures it: node verify/shot-thread.mjs
//
// Assertions do not see layout, and this is almost entirely layout. A thread
// is bubbles of wildly uneven length in two columns inside a scroller inside
// a page that also scrolls, and every one of those is a place something
// slides sideways or disappears.
//
// What gets measured, and why each one:
//   * nothing overflows sideways — this is read one-handed, in a driveway
//   * the two sides are actually on opposite sides, which is the only thing
//     telling you who said what without reading
//   * a URL with no spaces in it, and a word longer than the bubble, both
//     wrap instead of widening the column
//   * an automatic message looks different from one a person typed
//   * a failed message is visibly failed
//   * the newest message is the one you are looking at, not the oldest
//   * the composer clears 44px, because it is pressed with a thumb
//
// Leaves two PNGs to look at.

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

/*
 * A conversation with every shape of message in it, including the awkward
 * ones.
 *
 * The quote is the automatic kind. The long one from the customer is what
 * actually arrives when somebody describes a house. The URL is the case that
 * widens a column if nothing stops it, and the German compound is the
 * single unbreakable word — both are real: customers paste links, and
 * "Hausverwaltungsgesellschaft" is a word a Corvallis property manager has
 * in their signature. The failed one is a text to a landline.
 */
const NOW = Date.parse("2026-10-06T16:30:00Z");
const ago = (mins) => new Date(NOW - mins * 60000).toISOString();

const THREAD = [
  {
    id: 1, direction: "out", kind: "quote", status: "sent",
    body: "Hi Dana, here's your quote from Sky Blue Cleaning Co. for $340: https://crm.skybluecleaningco.com/q/8fK2p. Reply STOP to opt out.",
    created_at: ago(2880), sent_at: ago(2880), delivered_at: ago(2879),
    sent_by: null, error: null,
  },
  {
    id: 2, direction: "in", kind: "inbound", status: "received",
    body: "Thanks! Quick question before I say yes - we have those tall windows over the stairwell at the back, the ones that go up two storeys, and last time someone came out they said they'd need a different ladder and charged extra. Is that included in the 340 or is it on top?",
    created_at: ago(2810), sent_by: null, error: null,
  },
  {
    id: 3, direction: "out", kind: "manual", status: "sent",
    body: "Good question - that's included. We bring the 28ft and the pole set on every job.",
    created_at: ago(2800), sent_at: ago(2800), delivered_at: ago(2799),
    sent_by: "Hayden Mortensen", error: null,
  },
  {
    id: 4, direction: "in", kind: "inbound", status: "received",
    body: "Perfect",
    created_at: ago(2790), sent_by: null, error: null,
  },
  {
    id: 5, direction: "out", kind: "nudge_booked", status: "sent",
    body: "You're booked in with Sky Blue Cleaning Co. for Tue 7 Oct at 9:00am. Reply STOP to opt out.",
    created_at: ago(1440), sent_at: ago(1440), delivered_at: ago(1439),
    sent_by: null, error: null,
  },
  {
    id: 6, direction: "out", kind: "reminder", status: "undelivered",
    body: "Reminder: we're round tomorrow morning. Details at https://crm.skybluecleaningco.com/j/aa11bb22cc33dd44ee55ff66",
    created_at: ago(200), sent_at: ago(200), delivered_at: null,
    sent_by: null, error: "carrier reported undeliverable - landline",
  },
  {
    id: 7, direction: "in", kind: "inbound", status: "received",
    body: "Hausverwaltungsgesellschaftsvertretung",
    created_at: ago(40), sent_by: null, error: null,
  },
  {
    id: 8, direction: "out", kind: "manual", status: "queued",
    body: "On my way - about fifteen minutes out.",
    created_at: ago(2), sent_at: null, delivered_at: null,
    sent_by: "Jordan Mortensen", error: null,
  },
];

const dir = mkdtempSync(join(tmpdir(), "thread-"));
const bundle = join(dir, "app.js");

const ENTRY = `
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import TextThread from "./src/components/TextThread.jsx";

  createRoot(document.getElementById("root")).render(
    h(TextThread, { phone: "5415550101", leadId: "lead-1" })
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
  plugins: [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /^virtual-entry$/ }, (a) => ({ path: a.path, namespace: "e" }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: ENTRY, loader: "jsx", resolveDir: process.cwd(),
        }));

        // Stubbed at the CLIENT, not at the service. describeMessage() and
        // deliveryState() decide what every bubble looks like, and stubbing
        // textService would replace exactly the code being measured.
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents: `export const supabase = {
            auth: { getSession: async () => ({ data: { session: null } }) },
            rpc: async () => ({ data: ${JSON.stringify(THREAD)}, error: null }),
          };`,
          loader: "js",
        }));
      },
    },
  ],
});

const js = readFileSync(bundle, "utf8");
// The CSS esbuild emitted, not a filename typed here. TextThread.jsx does
// `import "./TextThread.css"` itself, so this follows whatever it imports —
// which is what stops the harness and the app drifting apart. See the long
// note in verify/shot-lead-split.mjs: a hand-written list lost the global
// reset once and the entire thread stylesheet once.
const css =
  readFileSync("src/index.css", "utf8") +
  readFileSync(bundle.replace(/\.js$/, ".css"), "utf8");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

for (const width of [390, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });

  await page.setContent(`<!doctype html><html><head><style>
    :root {
      --text-xs: 12px; --text-sm: 14px; --text-md: 15px;
      --text-base: 16px; --text-lg: 18px; --text-xl: 20px; --text-2xl: 24px;
    }
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; background: #ffffff; }
    ${css}
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.waitForSelector(".thread__bubble", { timeout: 5000 });

  // Type into the composer so the counter and the Send button are in the
  // shot. An empty box proves nothing about either.
  await page.fill(".thread__input", "Running ten minutes late - still fine to come?");

  await page.screenshot({ path: `verify/shot-thread-${width}.png`, fullPage: true });

  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".thread__row")];
    const scroller = document.querySelector(".thread__scroll");
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const centre = scroller.getBoundingClientRect().left
      + scroller.getBoundingClientRect().width / 2;

    return {
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      rows: rows.length,

      // Sides. Every outgoing bubble right of centre, every incoming one
      // left of it — which is the only thing telling you who said what
      // before you have read a word.
      mineLeftOfCentre: rows
        .filter((r) => r.classList.contains("thread__row--mine"))
        .filter((r) => mid(r) <= centre).length,
      theirsRightOfCentre: rows
        .filter((r) => r.classList.contains("thread__row--theirs"))
        .filter((r) => mid(r) >= centre).length,

      // Anything wider than its scroller is the long-URL bug.
      tooWide: rows
        .filter((r) => r.getBoundingClientRect().width > scroller.clientWidth - 20)
        .map((r) => r.textContent.slice(0, 30)),

      // The scroller itself must not scroll sideways.
      scrollerOverflows: scroller.scrollWidth > scroller.clientWidth + 1,

      // Pinned to the newest message.
      atBottom:
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,

      autoBubbles: document.querySelectorAll(".thread__bubble--auto").length,
      failedBubbles: document.querySelectorAll(".thread__bubble--failed").length,

      states: [...document.querySelectorAll(".thread__state")].map((e) => e.textContent.trim()),
      whos: [...document.querySelectorAll(".thread__who")].map((e) => e.textContent.trim()),
      why: [...document.querySelectorAll(".thread__why")].map((e) => e.textContent.trim()),

      count: document.querySelector(".thread__count")?.textContent?.trim(),

      // A missing stylesheet throws nothing and fails no assertion about
      // text or structure; only a screenshot shows it. Each of these has a
      // border-radius of its own, so a zero means its stylesheet is absent.
      unstyled: [
        [".thread__bubble", document.querySelector(".thread__bubble")],
        [".thread__input", document.querySelector(".thread__input")],
        [".thread__send", document.querySelector(".thread__send")],
      ]
        .filter(([, el]) => el)
        .filter(([, el]) => parseFloat(getComputedStyle(el).borderRadius) === 0)
        .map(([sel]) => sel),

      // The longest line anybody has to read, in pixels. A percentage cap
      // alone is not a cap on a wide screen: 78% of a desktop panel is a
      // line over a thousand pixels long, and past about 75 characters the
      // eye loses its place coming back to the left edge.
      widestBubble: Math.max(
        ...[...document.querySelectorAll(".thread__bubble")]
          .map((b) => b.getBoundingClientRect().width)
      ),

      shortTaps: [...document.querySelectorAll("button")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.height < 44 && el.classList.contains("thread__send");
        })
        .map((el) => el.className),

      // The composer must be reachable without scrolling past the thread —
      // a fixed-height scroller is what buys that, and losing it is the
      // regression nobody notices until a chatty customer.
      composerTop: document.querySelector(".thread__compose").getBoundingClientRect().top,

      // A meta line wider than the bubble it belongs to. The row is a
      // fixed-width column, so anything that refuses to wrap inside it
      // hangs off the side — and on the outgoing side that side is the
      // right-hand edge of the screen.
      metaOverflow: [...document.querySelectorAll(".thread__meta")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          return r.right > s.right - 8 || r.left < s.left + 8;
        })
        .map((el) => el.textContent.trim().slice(0, 40)),
    };
  });

  chk(`${width}px — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);

  chk(`${width}px — THE POINT: the thread is actually styled`,
    m.unstyled.length === 0,
    `${m.unstyled.join(", ")} rendered with browser defaults`);
  chk(`${width}px — every message is on screen`, m.rows === 8, String(m.rows));

  chk(
    `${width}px — THE POINT: our messages are on the right, theirs on the left`,
    m.mineLeftOfCentre === 0 && m.theirsRightOfCentre === 0,
    `mine on the left: ${m.mineLeftOfCentre}, theirs on the right: ${m.theirsRightOfCentre}`
  );

  chk(
    `${width}px — THE POINT: a long URL wraps instead of widening the column`,
    m.tooWide.length === 0 && !m.scrollerOverflows,
    m.tooWide.join(" | ")
  );

  chk(
    `${width}px — ...and so does an unbreakable word`,
    !m.scrollerOverflows,
    "overflow-wrap: anywhere is what does this"
  );

  chk(
    `${width}px — THE POINT: it opens on the newest message, not the oldest`,
    m.atBottom,
    "a thread that opens two years ago is a thread nobody scrolls"
  );

  chk(
    `${width}px — an automatic message looks different from a typed one`,
    m.autoBubbles === 3,
    `${m.autoBubbles} of 3 — quote, booked and reminder`
  );

  chk(`${width}px — a message that did not arrive is visibly failed`,
    m.failedBubbles === 1, String(m.failedBubbles));
  chk(`${width}px — ...and says why, in the carrier's words`,
    m.why.some((w) => /landline/.test(w)), m.why.join(" | "));

  chk(`${width}px — delivery is shown where it is known`,
    m.states.filter((s) => s === "Delivered").length === 3, m.states.join(","));
  chk(`${width}px — ...and a queued one says so`,
    m.states.includes("Sending…"), m.states.join(","));

  chk(`${width}px — a typed message carries its author`,
    m.whos.includes("Hayden Mortensen") && m.whos.includes("Jordan Mortensen"),
    m.whos.join(","));
  chk(`${width}px — ...and an automatic one is named as automatic`,
    m.whos.includes("Automatic"), m.whos.join(","));

  chk(`${width}px — THE POINT: no line is longer than the eye can track back`,
    m.widestBubble <= 560,
    `${Math.round(m.widestBubble)}px — a percentage cap alone lets this run ` +
      `the full width of a desktop window`);

  chk(`${width}px — the composer counts what you typed`,
    /46 characters/.test(m.count || ""), m.count);

  chk(`${width}px — THE POINT: no meta line hangs off the edge`,
    m.metaOverflow.length === 0,
    m.metaOverflow.join(" | ") + " — the author, the time and the delivery " +
      "state are three items that have to be allowed to wrap");

  chk(`${width}px — Send clears 44px`, m.shortTaps.length === 0, m.shortTaps.join(","));

  chk(`${width}px — the composer is reachable without scrolling the page`,
    m.composerTop < 1000,
    `${Math.round(m.composerTop)}px down a 1000px viewport — the scroller's ` +
      `max-height is what keeps it up here`);

  await page.close();
}

await browser.close();

console.log(bad === 0
  ? "\nall ok — two PNGs in verify/ to look at\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
