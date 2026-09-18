// Renders the four states of the public quote page at phone width.
//
// This is the only page in the app a customer ever sees. It is also the only
// one where a layout mistake costs a booking rather than an eye-roll — so it
// gets photographed in every state, not just the happy one.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("src/pages/quote/PublicQuote.css", "utf8");

const brand = `<div class="pq__brand"><span class="pq__brandname">Sky Blue <span class="pq__brandaccent">Cleaning Co.</span></span></div>`;
const contact = (quiet) =>
  `<p class="pq__contact ${quiet ? "pq__contact--quiet" : ""}">Questions? <a class="pq__tel" href="#">(541) 730-3593</a><span class="pq__sep">·</span><a href="#">company@skybluecleaningco.com</a></p>`;

const services = `<ul class="pq__services">
  <li>Residential window washing</li>
  <li>Gutter cleaning</li>
</ul>`;

const STATES = {
  ready: `${brand}<div class="pq__body">
    <h1 class="pq__h1">Your quote, Marilyn</h1>
    <p class="pq__addr">1014 NE Diane Pl, Corvallis, OR 97330</p>
    <div class="pq__amount">$250.00</div>
    ${services}
    <p class="pq__included">Every job includes the screens scrubbed and rinsed, plus the sills and tracks wiped down.</p>
    <p class="pq__note">We'll need access to the back garden — let us know if the side gate is locked.</p>
    <button class="pq__accept">Accept this quote</button>
    <p class="pq__fine">No deposit. No payment until the work is finished.</p>
    ${contact(true)}
  </div>`,

  accepted: `${brand}<div class="pq__body">
    <div class="pq__tick">✓</div>
    <h1 class="pq__h1">You're booked</h1>
    <p class="pq__p">Thanks Marilyn — we've got it. We'll be in touch shortly to agree a day that works for you. Nothing to pay until the job's done.</p>
    ${contact(false)}
  </div>`,

  expired: `${brand}<div class="pq__body">
    <h1 class="pq__h1">Your quote, Blythe</h1>
    <p class="pq__addr">55 SW 3rd St, Corvallis, OR</p>
    <div class="pq__amount">$300.00</div>
    ${services}
    <p class="pq__included">Every job includes the screens scrubbed and rinsed, plus the sills and tracks wiped down.</p>
    <p class="pq__expired">This quote has expired. Give us a call and we'll put a fresh one together — prices usually haven't moved.</p>
    ${contact(false)}
  </div>`,

  missing: `${brand}<div class="pq__body">
    <h1 class="pq__h1">We couldn't find that quote</h1>
    <p class="pq__p">The link may have expired or been mistyped. Give us a call and we'll get you a new one straight away.</p>
    ${contact(false)}
  </div>`,
};

// Rendered ABOVE the card, never inside it. The page below the bar has to be
// byte-for-byte what the customer sees — a preview altered to look safe stops
// being a preview — so the bar is the only difference, and it is the one thing
// the customer never receives.
const PREVIEW_BAR = `<p class="pq__preview"><strong>Preview.</strong> You're signed in, so opening this hasn't marked the quote as read. The customer sees this page without this bar — and only they can accept it.</p>`;

// The staff preview is the same "ready" page with the bar on top.
STATES.preview = STATES.ready;
const BEFORE = { preview: PREVIEW_BAR };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;

for (const [name, inner] of Object.entries(STATES)) {
  writeFileSync(
    `verify/.pq-${name}.html`,
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
     <style>${css}</style>
     <div class="pq">${BEFORE[name] || ""}<div class="pq__card">${inner}</div>
     <p class="pq__foot">Sky Blue Cleaning Co. · Corvallis, Oregon</p></div>`
  );

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${process.cwd()}/verify/.pq-${name}.html`);
  await page.waitForTimeout(150);

  // The customer is on a phone. A page that scrolls sideways reads as broken
  // before a word of it is taken in.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  if (overflow) {
    console.log(`FAIL  ${name}: page scrolls horizontally`);
    bad++;
  }

  // A phone number split across two lines reads as two broken half-numbers.
  // getClientRects() returns one rect per line box, so >1 means it wrapped.
  const telLines = await page.evaluate(
    () => document.querySelector(".pq__tel")?.getClientRects().length ?? 0
  );
  if (telLines !== 1) {
    console.log(`FAIL  ${name}: phone number renders on ${telLines} lines`);
    bad++;
  }

  // The preview bar has to line up with the card. Left floating at a
  // different width it reads as a browser extension or a broken element
  // rather than as part of the page — and the one job of this bar is to be
  // believed.
  let barOk = true;
  if (BEFORE[name]) {
    const [bar, card] = await page.evaluate(() => [
      document.querySelector(".pq__preview")?.getBoundingClientRect().width ?? -1,
      document.querySelector(".pq__card")?.getBoundingClientRect().width ?? -2,
    ]);
    barOk = bar > 0 && Math.abs(bar - card) < 1;
    if (!barOk) {
      console.log(`FAIL  ${name}: preview bar is ${bar}px against a ${card}px card`);
      bad++;
    }
  }

  if (!overflow && telLines === 1 && barOk) console.log(`ok    ${name}`);

  await page.screenshot({ path: `verify/shot-quote-${name}.png`, fullPage: true });
  await page.close();
}

await browser.close();
console.log(bad === 0 ? "all states render clean" : `${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
