// Renders the Communication page's two panels and measures them.
//
// Assertions do not see layout, and this change is mostly layout: a tag
// saying Email or Text on every row, in two lists that were already tight on
// a phone. The rows have a name, a route tag and an address competing for one
// line; the thing that goes wrong is the address eating the tag, or the tag
// pushing the whole row sideways.
//
// What gets measured, and why each one:
//   * nothing overflows sideways — this gets opened one-handed, outdoors
//   * every route tag is actually visible, not squeezed to nothing
//   * a phone-only customer is PICKABLE, which is the whole point of the
//     change and the one thing a screenshot can't tell you on its own
//   * every tap target clears 44px
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

const dir = mkdtempSync(join(tmpdir(), "comms-"));
const bundle = join(dir, "app.js");

/*
 * One of each kind of customer, including the awkward ones.
 *
 * Priya is the case this whole change exists for: a real customer, no email
 * address, perfectly textable — greyed out as "No email" until now. Stan has
 * replied STOP. Olive unsubscribed but still has a phone, and must stay
 * blocked. Marguerite is here because the longest name and the longest
 * address in one row is what breaks the layout.
 */
const CUSTOMERS = [
  { id: "1", name: "Jeff Krueger", email: "jeff.krueger@example.com", phone: "5415550101" },
  { id: "2", name: "Priya Raghunathan-Whitfield", email: null, phone: "5415550102" },
  { id: "3", name: "Marguerite Vandersteen", email: "marguerite.vandersteen@averylongdomainname.example.com", phone: "5415550103" },
  { id: "4", name: "Stan Stop", email: null, phone: "5415550144" },
  { id: "5", name: "Olive Optout", email: "olive@example.com", phone: "5415550155", email_opt_out: true },
  { id: "6", name: "Nora Nothing", email: null, phone: null },
  { id: "7", name: "Tim Ho", email: null, phone: "5415550107", last_review_request_at: "2026-09-20T17:00:00Z" },
];

const WOULD_SEND = [
  { name: "Jeff Krueger", to: "jeff.krueger@example.com", via: "email", due: "2026-10-02T07:00:00Z" },
  { name: "Priya Raghunathan-Whitfield", to: "+15415550102", via: "sms", due: "2026-10-02T07:00:00Z" },
  { name: "Marguerite Vandersteen", to: "marguerite.vandersteen@averylongdomainname.example.com", via: "email", due: "2026-10-02T07:00:00Z" },
  { name: "Tim Ho", to: "+15415550107", via: "sms", due: "2026-10-02T07:00:00Z" },
];

const ENTRY = `
  import { createRoot } from "react-dom/client";
  import { createElement as h, useEffect } from "react";
  import FollowUpRunner from "./src/components/FollowUpRunner.jsx";
  import SendToCustomer from "./src/components/SendToCustomer.jsx";

  function Page() {
    // Press "Who's due?" on mount so the preview list is on screen in the
    // screenshot. A shot of two buttons proves nothing about the rows.
    useEffect(() => {
      const btn = [...document.querySelectorAll(".fuprun__btn")]
        .find((b) => b.textContent.includes("Who's due"));
      btn?.click();
    }, []);

    return h("div", { className: "comms" },
      h("div", { className: "comms__panels" },
        h(FollowUpRunner, {}),
        h(SendToCustomer, {})
      )
    );
  }

  createRoot(document.getElementById("root")).render(h(Page));
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

        // The customer list and the STOP list, served from the fixture above.
        // Stubbed at the SERVICE boundary rather than at fetch, so the two
        // components are exercised exactly as they ship.
        b.onResolve({ filter: /customerService$/ }, (a) => ({ path: a.path, namespace: "cs" }));
        b.onLoad({ filter: /.*/, namespace: "cs" }, () => ({
          contents: `export const fetchCustomers = async () => (${JSON.stringify(CUSTOMERS)});`,
          loader: "js",
        }));

        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents: `export const supabase = {
            auth: { getSession: async () => ({ data: { session: null } }) },
            from: () => ({ select: async () => ({ data: [{ phone: "+15415550144" }], error: null }) }),
          };`,
          loader: "js",
        }));
      },
    },
  ],
});

const js = readFileSync(bundle, "utf8");
const css =
  readFileSync("src/components/FollowUpRunner.css", "utf8") +
  readFileSync("src/components/SendToCustomer.css", "utf8") +
  readFileSync("src/pages/customers/Communication.css", "utf8");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

for (const width of [390, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });

  // The page is rendered from a string, so there is no origin for a
  // relative /api/ call to resolve against — page.route never sees it.
  // fetch is replaced in the document instead, which also keeps the
  // component's own error handling in the loop.
  const PREVIEW = JSON.stringify({
    mode: "preview",
    configured_mode: "send",
    swept: 0,
    sent: 0,
    failed: 0,
    would_send: WOULD_SEND,
  });

  await page.setContent(`<!doctype html><html><head><script>
    window.fetch = async () => ({ ok: true, json: async () => (${PREVIEW}) });
  </script><style>
    :root {
      --text-xs: 12px; --text-sm: 14px; --text-md: 15px;
      --text-base: 16px; --text-lg: 18px; --text-xl: 20px; --text-2xl: 24px;
    }
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; background: #f1f5f9; }
    .comms__panels { display: grid; gap: 20px; }
    @media (min-width: 900px) { .comms__panels { grid-template-columns: 1fr 1fr; align-items: start; } }
    ${css}
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.waitForSelector(".stc__row", { timeout: 5000 });
  await page.waitForSelector(".fuprun__row", { timeout: 5000 });

  await page.screenshot({ path: `verify/shot-comms-${width}.png`, fullPage: true });

  const m = await page.evaluate(() => {
    const rowFor = (name) =>
      [...document.querySelectorAll(".stc__row")].find((li) =>
        li.textContent.includes(name)
      );
    const pick = (name) => rowFor(name)?.querySelector(".stc__pick");
    const tagIn = (name) => rowFor(name)?.querySelector(".stc__via");

    return {
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,

      // The whole point of the change.
      priyaDisabled: pick("Priya")?.disabled,
      priyaTag: tagIn("Priya")?.textContent?.trim() || null,
      priyaShows: rowFor("Priya")?.textContent || "",

      // Still blocked, and for the stated reason.
      stanDisabled: pick("Stan")?.disabled,
      stanWhy: rowFor("Stan")?.querySelector(".stc__blocked")?.textContent?.trim(),
      oliveDisabled: pick("Olive")?.disabled,
      oliveWhy: rowFor("Olive")?.querySelector(".stc__blocked")?.textContent?.trim(),
      noraDisabled: pick("Nora")?.disabled,
      noraWhy: rowFor("Nora")?.querySelector(".stc__blocked")?.textContent?.trim(),

      jeffTag: tagIn("Jeff")?.textContent?.trim() || null,

      // Tags squeezed to nothing by a long address beside them.
      thinTags: [...document.querySelectorAll(".stc__via, .fuprun__via")]
        .filter((el) => el.getBoundingClientRect().width < 28)
        .map((el) => el.textContent.trim()),

      queueTags: [...document.querySelectorAll(".fuprun__via")].map((el) =>
        el.textContent.trim()
      ),
      queueAddrs: [...document.querySelectorAll(".fuprun__addr")].map((el) =>
        el.textContent.trim()
      ),
      queueCount: document.querySelector(".fuprun__count")?.textContent?.trim(),

      shortTaps: [...document.querySelectorAll("button")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.height < 44;
        })
        .map((el) => el.className),
    };
  });

  chk(`${width}px — nothing overflows sideways`, m.docW <= m.winW, `${m.docW} > ${m.winW}`);

  chk(
    `${width}px — THE POINT: a customer with no email can be picked`,
    m.priyaDisabled === false,
    "this row said 'No email' and was greyed out before Oct 2026"
  );
  chk(`${width}px — ...and is labelled as a text`, m.priyaTag === "Text", String(m.priyaTag));
  chk(
    `${width}px — ...showing the number, readably`,
    /\(541\) 555-0102/.test(m.priyaShows),
    m.priyaShows.replace(/\s+/g, " ").trim()
  );
  chk(`${width}px — a customer with an email is labelled as an email`, m.jeffTag === "Email");

  chk(`${width}px — a STOP reply is still blocked`, m.stanDisabled === true);
  chk(`${width}px — ...and says why`, m.stanWhy === "Replied STOP", String(m.stanWhy));
  chk(
    `${width}px — THE POINT: an unsubscribed customer stays blocked despite a phone`,
    m.oliveDisabled === true && m.oliveWhy === "Unsubscribed",
    `${m.oliveDisabled} / ${m.oliveWhy}`
  );
  chk(`${width}px — nothing on file is still blocked`, m.noraDisabled === true);
  chk(`${width}px — ...and says that`, m.noraWhy === "No email or mobile", String(m.noraWhy));

  chk(
    `${width}px — no route tag is squeezed to nothing`,
    m.thinTags.length === 0,
    m.thinTags.join(", ")
  );

  chk(
    `${width}px — the queue shows both routes`,
    m.queueTags.includes("Text") && m.queueTags.includes("Email"),
    m.queueTags.join(", ")
  );
  chk(
    `${width}px — and counts them separately`,
    /2 emails and 2 texts would go out/.test(m.queueCount || ""),
    m.queueCount
  );
  chk(
    `${width}px — queued numbers are shown as a person reads them`,
    m.queueAddrs.includes("(541) 555-0102") &&
      !m.queueAddrs.some((a) => a.startsWith("+1")),
    m.queueAddrs.join(", ")
  );

  chk(
    `${width}px — every tap target clears 44px`,
    m.shortTaps.length === 0,
    m.shortTaps.join(", ")
  );

  await page.close();
}

await browser.close();
console.log(bad === 0 ? "\nThe Communication page holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
