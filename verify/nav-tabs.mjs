// The section tab strip, driven for real at phone width.
//
// The scroller was reverted to a wrapping row once because it looked broken,
// and the reason it looked broken was NOT the scrolling — it was that the tab
// falling off the right-hand edge was the page you were standing on. So the
// assertions here are about that:
//
//   * whichever tab is active is visible without touching anything
//   * the strip really does scroll rather than wrapping or squeezing
//   * the fades tell the truth about whether there is more in that direction
//
// The real component with real React Router, not a re-implementation in the
// fixture — a fixture would test the fixture.
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "nt-"));
const bundle = join(dir, "app.js");

// Whichever tab the test says is active. Passed through the page URL's hash so
// one bundle covers every case.
await build({
  entryPoints: [join(dir, "entry.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: bundle,
  jsx: "automatic",
  logLevel: "warning",
  plugins: [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /entry\.jsx$/ }, (a) => ({ path: a.path, namespace: "e" }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: `
            import { createRoot } from "react-dom/client";
            import { createElement as h } from "react";
            import { MemoryRouter } from "react-router-dom";
            import NavTabs from "${process.cwd()}/src/components/NavTabs.jsx";

            // Today every section is one word. ?multi=1 swaps in a label
            // that isn't — see the note in the test below.
            const LABELS = new URLSearchParams(location.search).has("multi")
              ? ["Leads", "Jobs", "Schedule", "Income", "All customers", "Map"]
              : ["Leads", "Jobs", "Schedule", "Income", "Customers", "Map"];

            const TABS = LABELS.map((label) => ({
              label,
              root: "/" + label.toLowerCase().replace(/ /g, "-"),
              to: "/" + label.toLowerCase().replace(/ /g, "-"),
            }));

            const active = decodeURIComponent(location.hash.slice(1) || "Customers");

            createRoot(document.getElementById("root")).render(
              h(MemoryRouter, null,
                h("header", { className: "shell__bar" },
                  h("div", { className: "shell__brand" }, "Sky Blue CRM"),
                  h(NavTabs, {
                    tabs: TABS,
                    // Same slug transform the tab list uses, or a two-word
                    // active label never matches and nothing is highlighted.
                    isActive: (root) =>
                      root === "/" + active.toLowerCase().replace(/ /g, "-"),
                  }),
                  h("div", { className: "shell__user" },
                    h("button", { className: "shell__signout" }, "Sign out"))
                )
              )
            );
          `,
          loader: "jsx",
          resolveDir: process.cwd(),
        }));
      },
    },
    {
      name: "css",
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
        b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
});

const html = join(dir, "nav.html");
writeFileSync(
  html,
  `<!doctype html><meta charset=utf-8>
   <meta name=viewport content="width=device-width,initial-scale=1">
   <style>
     body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
     ${/* The type scale lives in index.css; without it every --text-* is
           unresolved and the tabs render at the inherited size. */""}
     ${readFileSync("src/index.css", "utf8")}
     ${readFileSync("src/App.css", "utf8")}
     ${readFileSync("src/components/NavTabs.css", "utf8")}
   </style>
   <div id="root"></div>
   <script>${readFileSync(bundle, "utf8")}</script>`
);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`  ok    ${what}`);
  else {
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad++;
  }
};

// Changing only the hash does not re-execute the page script, so the second
// and third cases were silently measuring the first one's render. Reload.
async function show(page, tab, opts = "") {
  await page.goto(`file://${html}${opts}#${tab}`);
  await page.reload();
  await page.waitForSelector(".shell__tab--active");
  // Longer than the 150ms opacity transition on the fades. At 120ms they were
  // measured mid-animation at ~0.95 and read as "off", which is a test that
  // fails for a reason that has nothing to do with the thing it is testing.
  await page.waitForTimeout(260);
}

// Settled, not exactly 1 or 0 — the fades are animated, and a strict equality
// here would depend on the frame the screenshot happened to land on.
const on = (v) => v >= 0.9;
const off = (v) => v <= 0.1;

async function measure(page) {
  return page.evaluate(() => {
    const nav = document.querySelector(".shell__nav");
    const wrap = document.querySelector(".shell__navwrap");
    const navBox = nav.getBoundingClientRect();
    const active = document.querySelector(".shell__tab--active");
    const tabs = [...document.querySelectorAll(".shell__tab")];

    const fullyVisible = (el) => {
      const b = el.getBoundingClientRect();
      return b.left >= navBox.left - 1 && b.right <= navBox.right + 1;
    };

    return {
      scrollable: nav.scrollWidth > nav.clientWidth + 1,
      scrollLeft: Math.round(nav.scrollLeft),
      maxScroll: Math.round(nav.scrollWidth - nav.clientWidth),
      edges: wrap.dataset.edges,
      activeLabel: active?.textContent ?? null,
      activeVisible: active ? fullyVisible(active) : false,
      // One row, always: every tab shares a top edge.
      rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      // A squeezed tab is a wrapped label; the strip must scroll instead.
      tallest: Math.max(...tabs.map((t) => Math.round(t.getBoundingClientRect().height))),
      headerOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      navTop: Math.round(wrap.getBoundingClientRect().top),
      brandBottom: Math.round(
        document.querySelector(".shell__brand").getBoundingClientRect().bottom
      ),
      ownRow:
        wrap.getBoundingClientRect().top >=
        document.querySelector(".shell__brand").getBoundingClientRect().bottom - 1,
      fade: (() => {
        const after = getComputedStyle(wrap, "::after").opacity;
        const before = getComputedStyle(wrap, "::before").opacity;
        return { before: Number(before), after: Number(after) };
      })(),
    };
  });
}

// 760 is the gap that was missed, and it took measuring to find: wide enough
// that the header is still one row, narrow enough that six tabs cannot fit
// beside the brand and the sign-out button. Without min-width: 0 on the
// wrapper the strip refuses to shrink below its content and pushes the whole
// page sideways instead of scrolling inside itself.
//
// No other width catches it. Below 720 the strip is full-width on its own
// row; by 800 everything genuinely fits. 800 was tried first and proved
// nothing — the nav had room, so removing min-width changed neither the
// passing nor the failing case.
for (const width of [390, 430, 760, 1100]) {
  console.log(`\n${width}px`);
  const page = await browser.newPage({ viewport: { width, height: 600 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Customers is second from the end — the tab that used to fall off.
  await show(page, "Customers");

  const m = await measure(page);

  chk("the header does not push the page sideways", !m.headerOverflow);
  if (width < 720) {
    // The strip belongs on its own full-width row under the brand at phone
    // width. It briefly did not: App.css and NavTabs.css both selected
    // .shell__navwrap at the same specificity, so the base `flex: 1` in one
    // overrode the media query's `flex: none` in the other purely on source
    // order, and the tabs stayed squeezed onto the brand's line.
    chk(
      "the strip gets its own row under the brand",
      m.ownRow,
      `strip top ${m.navTop}, brand bottom ${m.brandBottom}`
    );
  }
  chk("the tabs stay on one row", m.rows === 1, `${m.rows} rows`);
  chk("no tab label wraps", m.tallest <= 40, `${m.tallest}px tall`);

  if (width === 760) {
    chk("at tablet width the strip scrolls inside the header", m.scrollable);
    chk(
      "THE POINT: and the header does not grow to fit it",
      !m.headerOverflow,
      "the nav refused to shrink and pushed the page wider than the screen"
    );
    chk("the tab you are on is still visible", m.activeVisible, m.activeLabel);
  } else if (width < 720) {
    chk("the strip scrolls rather than wrapping", m.scrollable);
    // THE POINT. This is the exact failure that made it look cut off.
    chk(
      "THE POINT: the tab you are on is visible without scrolling anything",
      m.activeVisible,
      `${m.activeLabel} was off screen`
    );
    chk(
      "which means it had to scroll to get there",
      m.scrollLeft > 0,
      `scrollLeft ${m.scrollLeft}`
    );
    chk(
      "and a fade shows there is more to the left",
      on(m.fade.before),
      `edges="${m.edges}", left fade ${m.fade.before}`
    );
  } else {
    chk("on a laptop everything fits, so it does not scroll", !m.scrollable);
    chk("and no fade is shown", m.edges === "none" && off(m.fade.after), m.edges);
  }

  chk("nothing threw", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: `verify/shot-nav-${width}.png` });
  await page.close();
}

// --- the first and last tabs, where the fades have to tell the truth --------
console.log("\nedges at 390px");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });

  await show(page, "Leads");
  let m = await measure(page);
  chk("on the first tab the strip is at the start", m.scrollLeft === 0);
  chk("no fade on the left, because there is nothing to the left", off(m.fade.before));
  chk("but a fade on the right, because there is more", on(m.fade.after), m.edges);

  await show(page, "Map");
  m = await measure(page);
  chk("the last tab is visible too", m.activeVisible && m.activeLabel === "Map", m.activeLabel);
  chk(
    "scrolled to the end, so the right fade turns off",
    m.scrollLeft >= m.maxScroll - 1 && off(m.fade.after),
    `scrollLeft ${m.scrollLeft} of ${m.maxScroll}, edges="${m.edges}"`
  );
  chk("and the left fade turns on", on(m.fade.before));

  // Dragging by hand must update the fades too — they are driven by the
  // scroll event, not only by the initial layout.
  await page.evaluate(() => {
    document.querySelector(".shell__nav").scrollLeft = 20;
  });
  await page.waitForTimeout(260);
  m = await measure(page);
  chk(
    "scrolling by hand brings the right fade back",
    on(m.fade.after) && on(m.fade.before),
    `edges="${m.edges}"`
  );

  await page.close();
}

// --- a label that is more than one word ------------------------------------
//
// Every section is a single word today — Leads, Jobs, Schedule — which means
// `flex: 0 0 auto` and `white-space: nowrap` on a tab change nothing right
// now: a flex item cannot shrink below its min-content width, and for a
// one-word label that IS its full width.
//
// They are not dead, though. They are what stops the first two-word section
// ever added — "All customers", "Job history" — from being squeezed thin and
// broken across two lines inside a 60px header. Removing either one passes
// every other check in this file and fails these, which is the whole reason
// this case exists.
console.log("\ntwo-word label at 390px");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  await show(page, "All%20customers", "?multi=1");
  const m = await measure(page);

  chk("THE POINT: a two-word label is not broken across two lines", m.tallest <= 40, `${m.tallest}px tall`);
  chk("and is not squeezed — the strip scrolls instead", m.scrollable);
  chk("the tabs are still one row", m.rows === 1, `${m.rows} rows`);
  chk("and the two-word tab you are on is visible", m.activeVisible, m.activeLabel);
  await page.close();
}

await browser.close();
console.log(bad === 0 ? "\nthe tab strip holds" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
