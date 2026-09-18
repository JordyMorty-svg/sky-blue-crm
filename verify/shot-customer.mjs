// Photographs the customer-detail header at phone and desktop width.
//
// The bug was purely layout: four flex children with no wrapping, so at
// 390px the name broke across two lines and "+ Schedule a job" broke across
// two beside it. Nothing about that is visible in a unit test, and nothing
// about it is visible on a laptop either — which is why it shipped.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("src/pages/customers/Customers.css", "utf8");

// The real markup, matching CustomerDetail.jsx.
const header = (name) => `
  <div class="custdetail__namerow">
    <h1 class="custdetail__name">${name}</h1>
    <div class="custdetail__actions">
      <button class="custdetail__schedule">+ Schedule a job</button>
      <button class="custdetail__edit">History</button>
      <button class="custdetail__edit">Edit</button>
    </div>
  </div>
  <div class="custdetail__badges">
    <span class="custbadge custbadge--residential">Residential</span>
  </div>`;

// Short, the reported two-word case, and a long one — a commercial client
// name is the case that would break it again.
const NAMES = ["Ana Ruiz", "Mariyn coats", "Okonkwo Storefront & Bakery LLC"];

const html = `<!doctype html><meta charset=utf-8><style>
  ${css}
  body{margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}
  .case{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:14px}
  .w{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;font-weight:700;margin-bottom:10px}
</style>
${NAMES.map((n) => `<div class="case"><div class="w">${n}</div>${header(n)}</div>`).join("")}`;

writeFileSync("verify/.cust.html", html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;

for (const width of [390, 1100]) {
  const page = await browser.newPage({
    viewport: { width, height: 700 },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${process.cwd()}/verify/.cust.html`);
  await page.waitForTimeout(200);

  // Measure rather than eyeball. A button taller than a single line means its
  // label wrapped — the exact defect — and horizontal overflow means the row
  // is still pushing the page wider than the screen.
  const report = await page.$$eval(".case", (cases) =>
    cases.map((c) => {
      const btns = [...c.querySelectorAll("button")];
      return {
        name: c.querySelector(".w").textContent,
        tallest: Math.max(...btns.map((b) => Math.round(b.getBoundingClientRect().height))),
        nameH: Math.round(c.querySelector(".custdetail__name").getBoundingClientRect().height),
      };
    })
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );

  console.log(`\n${width}px  (page overflows horizontally: ${overflow})`);
  for (const r of report) {
    // A single-line pill at this font size is ~36px. Anything near 60 is two.
    const wrapped = r.tallest > 46;
    if (wrapped || overflow) bad++;
    console.log(
      `  ${wrapped ? "FAIL" : "ok  "}  ${r.name.padEnd(34)} tallest button ${r.tallest}px, name ${r.nameH}px`
    );
  }

  await page.screenshot({ path: `verify/shot-cust-${width}.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
