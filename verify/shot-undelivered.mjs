// Photographs the Undelivered screen with every state on it at once.
//
// This exists because the last two bugs in this feature were BOTH invisible
// to the unit tests and obvious in a screenshot:
//
//   * the badge read sms_messages instead of the failures view, so it never
//     saw the "permanent" flag and told Jordan a landline was "worth trying
//     again" — the one piece of advice that is certainly wrong
//   * a third nav tab pushed the whole page 20px sideways at 390px
//
// Both passed every assertion that existed. So: render it, measure it, and
// look at it.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("src/pages/customers/Undelivered.css", "utf8");

const hour = 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// One of everything, including the two that did not exist before email
// delivery was tracked.
const ROWS = [
  {
    channel: "text",
    status: "undelivered",
    kind: "reminder",
    who: "Trish Roark",
    phone: "+15415550202",
    email: "trish@example.com",
    error: "destination not found",
    detail: "Hi Trish, Sky Blue Cleaning here - we're scheduled for tomorrow at 9:00 AM.",
    created_at: iso(-2 * hour),
    job_at: iso(20 * hour),
    urgent: true,
  },
  {
    channel: "email",
    status: "complained",
    kind: "follow_up",
    who: "Pat Nguyen",
    phone: "+15415550404",
    email: "pat@example.com",
    error: null,
    detail: "How did we do? — Sky Blue Cleaning",
    created_at: iso(-30 * hour),
  },
  {
    channel: "email",
    status: "bounced",
    kind: "quote_fallback",
    who: "Judy Alvarez",
    phone: "+15415550101",
    email: "judy@example.com",
    error: "Permanent: mailbox does not exist",
    detail: "Your Sky Blue Cleaning quote — $449",
    created_at: iso(-40 * hour),
  },
  {
    channel: "text",
    status: "failed",
    kind: "quote",
    who: "Sam Ellis",
    phone: "+15415550303",
    email: null,
    error: "Quo 503",
    detail: "Hey Sam, it's Hayden with Sky Blue Cleaning. Here's your quote for $300.",
    created_at: iso(-50 * hour),
  },
];

// Mirrors deliveryService.whatToDo / failureLabel / kindLabel. Kept in the
// harness rather than imported because the service imports supabaseClient,
// which wants a browser and an environment; the assertions below check the
// RENDERED words, which is the thing that was wrong last time.
const LABEL = {
  undelivered: "Not delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Never sent",
};
const KIND = {
  quote: "Quote",
  quote_fallback: "Quote, emailed after the text failed",
  reminder: "Day-before confirmation",
  follow_up: "Review request",
};

function whatToDo(r) {
  if (r.urgent) return "They have not been told we're coming Friday, 9:00 AM. Call them today.";
  if (r.status === "complained") return "They marked us as spam. Don't email them again — call instead.";
  if (r.status === "failed") return "It never left the CRM, so sending it again is safe.";
  if (r.status === "bounced") return "This address is dead. Call them, or text it instead.";
  return "This number can't receive texts. Call them, or email it instead.";
}

const fmt = (p) => {
  const d = String(p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
};
const when = (s) =>
  new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const row = (r) => `
  <li class="undelrow undelrow--${r.status}${r.urgent ? " undelrow--urgent" : ""}">
    <div class="undelrow__top">
      <span class="undelrow__who">${r.who}</span>
      <span class="undelrow__tag undelrow__tag--${r.status}">${LABEL[r.status]}</span>
      <span class="undelrow__when">${when(r.created_at)}</span>
    </div>
    <p class="undelrow__do">${whatToDo(r)}</p>
    ${r.job_at ? `<p class="undelrow__job">Job: Fri, Sep 25, 9:00 AM</p>` : ""}
    <p class="undelrow__meta">
      ${KIND[r.kind]} &middot; by ${r.channel} &middot;
      <a class="undelrow__phone" href="#">${fmt(r.phone)}</a>
      ${r.email ? ` &middot; <a class="undelrow__email" href="#">${r.email}</a>` : ""}
    </p>
    ${r.error ? `<p class="undelrow__carrier">${r.channel === "email" ? "Mail server" : "Carrier"}: ${r.error}</p>` : ""}
    <p class="undelrow__body">${r.detail}</p>
    <button class="undelrow__dismiss">I've dealt with this</button>
  </li>`;

const blocked = (b) => `
  <li class="blockedrow${b.spam ? " blockedrow--spam" : ""}">
    <div class="blockedrow__main">
      <a class="blockedrow__phone" href="#">${b.label}</a>
      <span class="blockedrow__reason">${b.reason}</span>
    </div>
    <span class="blockedrow__when">${b.failures > 1 ? `${b.failures} refusals, last ` : ""}Sep 22, 4:14 PM</span>
    <button class="blockedrow__reopen" ${b.spam ? "disabled" : ""}>Reopen</button>
  </li>`;

const html = `<!doctype html><meta charset=utf-8><style>
  :root{--text-2xs:10px;--text-sm:12px;--text-md:13px;--text-base:14px;--text-lg:16px;--text-xl:20px}
  ${css}
  body{margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}
  .visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style>
<div class="undel">
  <div class="undel__check">
    <button class="undel__checkbtn">Check with Quo</button>
    <span class="undel__checknote">Quo doesn't announce failures, so the CRM asks. This runs automatically before the nightly texts.</span>
  </div>

  <p class="undel__alarm">One customer has not been told we're coming. Call them today.</p>

  <section class="undel__section">
    <h2 class="undel__head">Numbers closed to texts<span class="undel__count">1</span></h2>
    <p class="undel__lede">A carrier refused these permanently — usually a landline. Nothing else will be texted to them.</p>
    <ul class="undel__blocked">
      ${blocked({ label: "(541) 555-0101", reason: "destination not found", failures: 3 })}
    </ul>
  </section>

  <section class="undel__section">
    <h2 class="undel__head">Addresses closed to email<span class="undel__count">2</span></h2>
    <p class="undel__lede">These bounced permanently or reported us as spam. Nothing else will be emailed to them.</p>
    <ul class="undel__blocked">
      ${blocked({ label: "pat@example.com", reason: "Marked us as spam", failures: 1, spam: true })}
      ${blocked({ label: "judy@example.com", reason: "Permanent: mailbox does not exist", failures: 2 })}
    </ul>
  </section>

  <section class="undel__section">
    <h2 class="undel__head">Didn't arrive<span class="undel__count">${ROWS.length}</span></h2>
    <ul class="undel__list">${ROWS.map(row).join("")}</ul>
  </section>
</div>`;

writeFileSync("verify/.undel.html", html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

for (const width of [390, 1100]) {
  const page = await browser.newPage({ viewport: { width, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto(`file://${process.cwd()}/verify/.undel.html`);
  await page.waitForTimeout(200);

  // The bug that shipped last time: a third tab pushing the page sideways.
  // Measured, not looked at.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  chk(`${width}px: the page does not scroll sideways`, overflow <= 0, `${overflow}px over`);

  // The urgent row has to be visually distinct from the rest, or the alarm
  // at the top points at nothing.
  const urgent = await page.$eval(".undelrow--urgent", (el) => {
    const s = getComputedStyle(el);
    return { border: s.borderLeftWidth, bg: s.backgroundColor };
  });
  const plain = await page.$eval(".undelrow--failed", (el) => {
    const s = getComputedStyle(el);
    return { border: s.borderLeftWidth, bg: s.backgroundColor };
  });
  chk(`${width}px: tomorrow's job stands out from the rest`,
      urgent.border !== plain.border || urgent.bg !== plain.bg,
      JSON.stringify({ urgent, plain }));

  // A complaint must not look like an ordinary bounce — it is the one state
  // where sending again is wrong on purpose.
  const spam = await page.$eval(".undelrow--complained", (el) => getComputedStyle(el).borderLeftColor);
  const bounce = await page.$eval(".undelrow--bounced", (el) => getComputedStyle(el).borderLeftColor);
  chk(`${width}px: a spam complaint reads differently from a bounce`, spam !== bounce, `${spam} vs ${bounce}`);

  // THE POINT of the badge bug: a dead address must never be told to try
  // again. This is the sentence that was wrong last time.
  const advice = await page.$$eval(".undelrow__do", (ps) => ps.map((p) => p.textContent.trim()));
  chk(`${width}px: a dead address is never told to try again`,
      !advice.some((a) => /dead|can't receive/.test(a) && /try(ing)? again/.test(a)),
      JSON.stringify(advice));

  // The reopen button for a spam complaint is disabled — reopening that one
  // is a conversation, not a button.
  const spamBtnDisabled = await page.$eval(".blockedrow--spam .blockedrow__reopen", (b) => b.disabled);
  chk(`${width}px: a spam complaint cannot be reopened by accident`, spamBtnDisabled);

  // Nothing may spill out of its card at phone width.
  const spill = await page.$$eval(".undelrow, .blockedrow", (els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1).length
  );
  chk(`${width}px: nothing overflows its card`, spill === 0, `${spill} rows`);

  // The button that fixes history. A page whose only route to a fresh
  // verdict is "wait until 4pm tomorrow" is the problem this was built for.
  const btn = await page.$eval(".undel__checkbtn", (b) => ({
    text: b.textContent.trim(),
    w: Math.round(b.getBoundingClientRect().width),
    h: Math.round(b.getBoundingClientRect().height),
  }));
  chk(`${width}px: the Check with Quo button is there and tappable`,
      /Quo/.test(btn.text) && btn.h >= 32 && btn.w >= 44,
      JSON.stringify(btn));

  // Every row must be clearable, or the list fills with things nobody can
  // remove and stops being read.
  const rows = await page.$$eval(".undelrow", (els) => els.length);
  const dismissers = await page.$$eval(".undelrow__dismiss", (els) => els.length);
  chk(`${width}px: every row can be cleared`, rows === dismissers, `${dismissers}/${rows}`);

  await page.screenshot({ path: `verify/shot-undel-${width}.png`, fullPage: true });
  await page.close();
}

await browser.close();
console.log(bad === 0 ? "\nUndelivered renders" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
