// The actions menu, driven for real in a browser.
//
// A dropdown is mostly behaviour, and none of it shows up in a screenshot:
// whether Escape gets you out, whether a tap elsewhere closes it, whether the
// arrow keys do anything, whether choosing an item actually runs the action.
// Those are the ways a menu is worse than the buttons it replaced, so they
// are what this checks.
//
// The component is bundled and mounted with real React — not re-implemented
// in the fixture, which would test the fixture.
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rm-"));
const bundle = join(dir, "app.js");

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
            import RecordMenu from "${process.cwd()}/src/components/RecordMenu.jsx";

            // Recorded on the window so the test can assert that choosing an
            // item ran the action — the thing a menu exists to do.
            window.__chosen = [];

            const items = ["Schedule a job", "Send a quote", "History", "Edit"].map(
              (label) => ({
                label,
                tone: label === "Schedule a job" ? "primary" : undefined,
                onSelect: () => window.__chosen.push(label),
              })
            );

            createRoot(document.getElementById("root")).render(
              h("div", null,
                h("button", { id: "outside" }, "somewhere else"),
                h(RecordMenu, { label: "Actions", items })
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

const html = join(dir, "menu.html");
writeFileSync(
  html,
  `<!doctype html><meta charset=utf-8>
   <meta name=viewport content="width=device-width,initial-scale=1">
   <style>body{margin:0;padding:24px;font-family:system-ui,sans-serif}
   ${/* The scale, or every --text-* below is unresolved. */ ""}
   ${readFileSync("src/index.css", "utf8")}
   ${readFileSync("src/components/RecordMenu.css", "utf8")}</style>
   <div id="root"></div>
   <script>${readFileSync(bundle, "utf8")}</script>`
);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 430, height: 800 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`file://${html}`);
await page.waitForSelector(".recmenu__button");

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad++;
  }
};

const isOpen = () => page.locator(".recmenu__sheet").count().then((n) => n > 0);
const reset = async () => {
  if (await isOpen()) await page.keyboard.press("Escape");
};

// --- it starts closed -------------------------------------------------------
chk("THE POINT: the menu is closed until it is clicked", !(await isOpen()));
chk(
  "and says so to a screen reader",
  (await page.getAttribute(".recmenu__button", "aria-expanded")) === "false"
);
chk(
  "and announces itself as a menu",
  (await page.getAttribute(".recmenu__button", "aria-haspopup")) === "menu"
);

// --- opening ----------------------------------------------------------------
await page.click(".recmenu__button");
chk("clicking opens it", await isOpen());
chk(
  "aria-expanded follows",
  (await page.getAttribute(".recmenu__button", "aria-expanded")) === "true"
);
chk(
  "all four actions are there",
  (await page.locator(".recmenu__item").allTextContents()).join("|") ===
    "Schedule a job|Send a quote|History|Edit",
  (await page.locator(".recmenu__item").allTextContents()).join("|")
);
chk(
  "focus lands in the menu, not behind it",
  await page.evaluate(() => document.activeElement?.textContent === "Schedule a job"),
  await page.evaluate(() => document.activeElement?.textContent)
);

// The sheet hangs off the button's right edge; on a phone a left anchor would
// put half of it off screen.
const anchor = await page.evaluate(() => {
  const sheet = document.querySelector(".recmenu__sheet").getBoundingClientRect();
  const btn = document.querySelector(".recmenu__button").getBoundingClientRect();
  return {
    onScreen: sheet.left >= 0 && sheet.right <= document.documentElement.clientWidth,
    drift: Math.round(sheet.right - btn.right),
    below: sheet.top >= btn.bottom - 1,
  };
});
chk("the sheet stays on screen at phone width", anchor.onScreen);
// `right: 0` is measured against .recmenu, so this fails the moment that
// element stops shrink-wrapping — which is what a plain block child does.
chk(
  "the sheet is anchored to the button, not to whatever contains it",
  Math.abs(anchor.drift) <= 1,
  `sheet right edge is ${anchor.drift}px from the button's`
);
chk("and hangs below it", anchor.below);

// --- keyboard ---------------------------------------------------------------
await page.keyboard.press("ArrowDown");
chk(
  "ArrowDown walks to the next item",
  await page.evaluate(() => document.activeElement?.textContent === "Send a quote"),
  await page.evaluate(() => document.activeElement?.textContent)
);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
chk(
  "ArrowUp wraps to the last item",
  await page.evaluate(() => document.activeElement?.textContent === "Edit"),
  await page.evaluate(() => document.activeElement?.textContent)
);
await page.keyboard.press("Home");
chk(
  "Home jumps to the first",
  await page.evaluate(() => document.activeElement?.textContent === "Schedule a job")
);

// --- Escape -----------------------------------------------------------------
await page.keyboard.press("Escape");
chk("THE POINT: Escape closes it", !(await isOpen()));
chk(
  "and focus returns to the button, not nowhere",
  await page.evaluate(() =>
    document.activeElement?.classList.contains("recmenu__button")
  ),
  await page.evaluate(() => document.activeElement?.className)
);

// --- clicking away ----------------------------------------------------------
await page.click(".recmenu__button");
chk("it opens again", await isOpen());
await page.click("#outside");
chk(
  "THE POINT: tapping anywhere else closes it",
  !(await isOpen()),
  "on a touch screen this is the only way out besides the button"
);

// --- the button toggles -----------------------------------------------------
await page.click(".recmenu__button");
await page.click(".recmenu__button");
chk("clicking the button again closes it", !(await isOpen()));

// --- choosing an item -------------------------------------------------------
await reset();
await page.click(".recmenu__button");
await page.locator(".recmenu__item", { hasText: "Send a quote" }).click();

chk(
  "choosing an item runs its action",
  (await page.evaluate(() => window.__chosen)).includes("Send a quote"),
  JSON.stringify(await page.evaluate(() => window.__chosen))
);
// Several of these navigate away, and a menu left open over the next screen
// is a ghost nobody can explain.
chk("and closes the menu", !(await isOpen()));

chk("nothing threw along the way", errors.length === 0, errors.join(" | "));

await page.screenshot({ path: "verify/shot-record-menu.png" });
await page.click(".recmenu__button");
await page.screenshot({ path: "verify/shot-record-menu-open.png" });

await browser.close();
console.log(bad === 0 ? "\nthe menu behaves" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
