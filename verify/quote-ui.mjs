// Two checks on the quote UI, both of which a screenshot alone would miss.
//
// 1. The module graph resolves. QuotesPanel, QuoteModal and PublicQuote sit
//    across three folders and pull from two services; a mistyped path or a
//    renamed export is a white screen in production and nothing at all in
//    development until the route is opened.
//
// 2. The compose modal lays out at phone width. It is used standing on a
//    driveway, one-handed, and it has the one control in this app that must
//    not be fiddly: the price box.
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "qui-"));
let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad++;
  }
};

// Everything the browser provides and a bundle shouldn't: the Supabase client
// (network + import.meta.env) and the stylesheets (Vite handles those).
const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
    b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
      contents: "export const supabase = { auth: { getSession: async () => ({ data: {} }) } };",
      loader: "js",
    }));
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
    b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  },
};

// Emitted inside the project, not /tmp, so the externalised react resolves
// against node_modules the same way it will in the app.
const out = "verify/.quote-ui-bundle.mjs";
try {
  await build({
    entryPoints: [join(dir, "entry.jsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server", "react-router-dom"],
    plugins: [
      {
        name: "entry",
        setup(b) {
          b.onResolve({ filter: /entry\.jsx$/ }, (a) => ({ path: a.path, namespace: "entry" }));
          b.onLoad({ filter: /.*/, namespace: "entry" }, () => ({
            contents: `
              export { default as QuotesPanel } from "${process.cwd()}/src/components/QuotesPanel.jsx";
              export { default as QuoteModal } from "${process.cwd()}/src/components/QuoteModal.jsx";
              export { default as PublicQuote } from "${process.cwd()}/src/pages/quote/PublicQuote.jsx";
            `,
            loader: "js",
            resolveDir: process.cwd(),
          }));
        },
      },
      stubs,
    ],
    logLevel: "silent",
  });
  chk("every quote module and import resolves", true);
} catch (e) {
  chk("every quote module and import resolves", false, String(e.message).split("\n")[0]);
  process.exit(1);
}

const { QuoteModal } = await import("./.quote-ui-bundle.mjs");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");

// The real component, not a fixture. A fixture drifts; this cannot.
const markup = renderToStaticMarkup(
  createElement(QuoteModal, {
    leadId: "aaaa",
    customerName: "Marilyn Hollingsworth",
    customerEmail: null,
    customerPhone: "(541) 730-3593",
    address: "1014 NE Diane Pl, Corvallis, OR 97330",
    suggestedAmount: 250,
    onClose: () => {},
    onSent: () => {},
  })
);

chk("the modal renders its price box", markup.includes('inputMode="decimal"') || markup.includes("quotem__amount"), "");
chk(
  "with no email on file it offers a link instead",
  markup.includes("you") && markup.includes("link to text them"),
  ""
);
chk(
  "every service is offered as a chip",
  (markup.match(/quotem__service/g) || []).length >= 6,
  `${(markup.match(/quotem__service/g) || []).length} chips`
);

const css = readFileSync("src/components/QuoteModal.css", "utf8");
const html = join(dir, "modal.html");
writeFileSync(
  html,
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
   <style>body{margin:0}${css}</style>${markup}`
);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`file://${html}`);
await page.waitForTimeout(150);

chk(
  "the modal does not scroll the page sideways at 390px",
  !(await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  ))
);

// A tap target under 44px is the one Apple calls too small, and this is the
// control someone hits with a wet glove.
const sendBox = await page.evaluate(() => {
  const el = document.querySelector(".quotem__send");
  const r = el.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), lines: el.getClientRects().length };
});
chk("the send button is a real tap target", sendBox.h >= 44, `${sendBox.h}px tall`);
chk("the send button label stays on one line", sendBox.lines === 1, `${sendBox.lines} lines`);

const priceH = await page.evaluate(() =>
  Math.round(document.querySelector(".quotem__amountwrap").getBoundingClientRect().height)
);
chk("the price field is comfortably tappable", priceH >= 48, `${priceH}px tall`);

// iOS zooms the whole page when a focused input computes under 16px. On this
// screen that reflows the modal out from under the thumb mid-entry.
const fontPx = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector(".quotem__amount")).fontSize)
);
chk("the price input is 16px or larger, so iOS won't zoom", fontPx >= 16, `${fontPx}px`);

await page.screenshot({ path: "verify/shot-quote-modal.png", fullPage: true });
await browser.close();

console.log(bad === 0 ? "\nquote UI holds" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
