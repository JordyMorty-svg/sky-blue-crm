// The customer page and the app shell at real phone widths.
//
// This exists because the previous fix was only half a fix. Stopping the
// button labels wrapping was measured and passed; nobody measured where the
// buttons ENDED UP, and on a phone they sit hard against the right edge under
// a left-aligned name, which is what "weird formatting" actually looked like.
//
// So the assertions here are about ALIGNMENT and VISIBILITY, not just about
// nothing overflowing. Three things a screenshot shows instantly and a unit
// test never would:
//
//   * the action buttons line up with the name above them
//   * a section heading is not left stranded above content it doesn't describe
//
// The tab strip used to be checked here too. It isn't any more: its styling
// moved into NavTabs.css with the behaviour that goes with it, and a static
// fixture cannot run the scroll-to-the-active-tab logic — so the check went
// on passing while testing nothing. verify/nav-tabs.mjs drives the real
// component instead.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

// A long commercial name is passed as an argument so the same file can check
// the case that crowds the badge: `node verify/shot-mobile.mjs "Okonkwo
// Storefront & Bakery LLC"`.
const NAME = process.argv[2] || "Susan";

const customersCss = readFileSync("src/pages/customers/Customers.css", "utf8");
const appCss = readFileSync("src/App.css", "utf8");
const menuCss = readFileSync("src/components/RecordMenu.css", "utf8");
const panelCss = readFileSync("src/components/QuotesPanel.css", "utf8");

// The real markup, matching App.jsx and CustomerDetail.jsx.
// Enough of the header to put the page under something the right height.
// The strip itself is verify/nav-tabs.mjs's job.
const shell = `
  <header class="shell__bar">
    <div class="shell__brand">Sky Blue <span class="shell__brand-accent">CRM</span></div>
    <div class="shell__user">
      <span class="shell__email">Jordan<span class="shell__role">admin</span></span>
      <button class="shell__signout">Sign out</button>
    </div>
  </header>`;

// Susan: a real customer with a phone and NO email, which is the common case
// for anyone added through Add past jobs — and the case that strands the
// "Email" heading above a review tickbox.
const page = (name = "Susan") => `
  <main class="shell__main">
    <div class="custdetail">
      <button class="custdetail__back">← Back to customers</button>
      <div class="custdetail__namerow">
        <h1 class="custdetail__name">${name} <span
          class="custbadge custbadge--residential custdetail__typebadge">Residential</span></h1>
        <div class="recmenu">
          <button class="recmenu__button" aria-haspopup="menu" aria-expanded="false">
            Actions<span class="recmenu__caret"></span>
          </button>
        </div>
      </div>
      <div class="custdetail__info">
        <a class="custdetail__phone" href="#">(541) 286-8421</a>
        <span>1200 NE Conroy Pl, Corvallis, OR 97330, USA</span>
      </div>
      <div class="custprefs">
        <span class="custprefs__head" data-head>Reviews</span>
        <div class="custprefs__grid">
          <label class="custpref">
            <input type="checkbox" />
            <span class="custpref__body">
              <span class="custpref__label">Already left a Google review</span>
            </span>
          </label>
        </div>
      </div>

      <div class="quotes">
        <div class="quotes__head"><h2 class="quotes__title">Quotes</h2></div>
        <p class="quotes__empty">No quotes sent yet.</p>
      </div>

      <h2 class="custdetail__subhead">Job history</h2>
    </div>
  </main>`;

const html = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
  ${appCss}
  ${customersCss}
  ${menuCss}
  ${panelCss}
  body{margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
</style>
<div class="shell">${shell}${page(NAME)}</div>`;

writeFileSync("verify/.mobile.html", html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`  ok    ${what}`);
  else {
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad++;
  }
};

// 390 = iPhone 13/14/15. 430 = the Pro Max Jordan is holding. 600 = a small
// tablet, the awkward width where a short name and the buttons might share a
// line. 1100 = a laptop, where right-aligned actions are correct and must
// stay that way.
for (const width of [390, 430, 600, 1100]) {
  console.log(`\n${width}px`);
  const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(`file://${process.cwd()}/verify/.mobile.html`);
  await p.waitForTimeout(150);

  const m = await p.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const name = r(".custdetail__name");
    const actions = r(".recmenu");
    const badge = r(".custdetail__typebadge");
    const info = r(".custdetail__info");

    // The last LINE of the name, not the name's whole box. A name that wraps
    // to three lines has a box centre halfway up the block, while the badge
    // sits at the end of the final line — comparing the two said the badge
    // had drifted when it was exactly where it should be.
    const h1 = document.querySelector(".custdetail__name");
    const range = document.createRange();
    range.selectNodeContents(h1.firstChild);
    const lines = [...range.getClientRects()];
    const lastLine = lines[lines.length - 1];

    return {
      nameLeft: Math.round(name.left),
      actionsLeft: Math.round(actions.left),
      badge: {
        left: Math.round(badge.left),
        top: Math.round(badge.top),
        height: Math.round(badge.height),
        // Vertical centres, for checking it sits against the name rather
        // than hanging off its baseline.
        midY: Math.round(badge.top + badge.height / 2),
      },
      lastLine: {
        midY: Math.round(lastLine.top + lastLine.height / 2),
        right: Math.round(lastLine.right),
      },
      nameLines: lines.length,
      infoLeft: Math.round(info.left),
      infoTop: Math.round(info.top),
      actionsBottom: Math.round(actions.bottom),
      nameTop: Math.round(name.top),
      nameBottom: Math.round(name.bottom),
      // On its own row only when it starts at or below the BOTTOM of the
      // name. Comparing tops looked right and was wrong: align-items:center
      // pushes a short actions box down beside a name that has wrapped to
      // three lines, so a long commercial name reported as "wrapped" while
      // the buttons were sitting happily beside it.
      wrapped: Math.round(actions.top) >= Math.round(name.bottom) - 2,
      containerRight: Math.round(
        document.querySelector(".custdetail").getBoundingClientRect().right
      ),
      actionsRight: Math.round(actions.right),
      menu: (() => {
        const el = document.querySelector(".recmenu__button");
        const box = el.getBoundingClientRect();
        return {
          height: Math.round(box.height),
          right: Math.round(box.right),
          top: Math.round(box.top),
          lines: el.getClientRects().length,
        };
      })(),

      // The two section headings. They are styled in two different files —
      // Customers.css and QuotesPanel.css, which cannot reference each other
      // because the panel is shared with the leads page — so they are
      // compared against EACH OTHER rather than against fixed numbers. That
      // way the check still means something if either is restyled.
      headings: (() => {
        const q = document.querySelector(".quotes__title");
        const j = document.querySelector(".custdetail__subhead");
        const read = (el) => {
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            left: Math.round(box.left),
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            color: cs.color,
            // The gap below the heading, to the first thing under it.
            below: Math.round(
              el.nextElementSibling
                ? el.nextElementSibling.getBoundingClientRect().top - box.bottom
                : parseFloat(cs.marginBottom)
            ),
          };
        };
        // The Quotes heading is wrapped in .quotes__head, so its gap to the
        // content below comes from that wrapper rather than from itself.
        const quotes = read(q);
        quotes.below = Math.round(
          document.querySelector(".quotes__empty").getBoundingClientRect().top -
            q.getBoundingClientRect().bottom
        );
        return { quotes, job: read(j) };
      })(),
      phone: (() => {
        const el = document.querySelector(".custdetail__phone");
        const box = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          decoration: cs.textDecorationLine,
          underlined: cs.textDecorationLine.includes("underline"),
          weight: Number(cs.fontWeight),
          height: Math.round(box.height),
          width: Math.round(box.width),
        };
      })(),
      pageOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  chk("the page does not scroll sideways", !m.pageOverflow);
  // The phone had no CSS rule of its own, so it rendered as a browser-default
  // underlined link — the only unstyled blue on the page.
  chk(
    "the phone number is styled, not a default browser link",
    m.phone.underlined === false && m.phone.weight >= 600,
    `text-decoration ${m.phone.decoration}, weight ${m.phone.weight}`
  );
  // ~17px unstyled. 28 is the floor worth defending: roughly double, without
  // turning a line of contact detail into something that looks like a button.
  chk(
    "the phone number is a comfortable tap target",
    m.phone.height >= 28,
    `${m.phone.height}px tall`
  );
  chk(
    "the phone is not wider than its own text",
    m.phone.width < 200,
    `${m.phone.width}px — a full-width link swallows taps meant for the address`
  );
  // THE POINT of this change: the type badge belongs to the name, not to the
  // buttons. It used to sit on its own row UNDER them, which read as a
  // property of the actions rather than of the customer.
  // THE POINT of this change: the badge belongs to the name, not to the
  // buttons. It used to sit on its own row UNDER them, which read as a
  // property of the actions rather than of the customer.
  // THE POINT of this change, and the assertion has to be able to tell the
  // OLD layout from the new one. "Below the name and left-aligned" was true
  // of both — the badge used to sit on its own row under the buttons, at the
  // same left margin.
  //
  // What separates them is CONTAINMENT: the badge now lives inside the
  // heading, so it falls entirely within the heading's box however many lines
  // the name takes. An earlier version compared it to the bottom of the
  // actions instead, which measured the geometry of a row that no longer
  // exists — once the menu moved onto the name's line, a long name pushed the
  // badge below the vertically-centred menu and the check failed on a layout
  // that was perfectly correct.
  chk(
    "the badge is inside the name heading, not a row of its own",
    m.badge.top >= m.nameTop - 1 && m.badge.top < m.nameBottom,
    `badge ${m.badge.top}, heading spans ${m.nameTop}–${m.nameBottom}`
  );
  // Two correct outcomes, and no third. Either it sits at the end of the
  // name's last line, or — when a long name leaves no room there — it drops
  // to the next line and lines up under the name. What must never happen is
  // the badge floating somewhere in between, which is how it looked when it
  // lived under the buttons.
  const onLastLine =
    Math.abs(m.badge.midY - m.lastLine.midY) <= 6 &&
    m.badge.left >= m.lastLine.right &&
    m.badge.left - m.lastLine.right <= 16;
  const neatlyBelow =
    m.badge.midY > m.lastLine.midY && Math.abs(m.badge.left - m.nameLeft) <= 6;

  chk(
    "the badge follows the name, or drops flush beneath it",
    onLastLine || neatlyBelow,
    onLastLine
      ? ""
      : `badge at ${m.badge.left},${m.badge.midY}; name left ${m.nameLeft}, last line ends ${m.lastLine.right} at ${m.lastLine.midY}`
  );
  // Inheriting the 1.6rem heading's line-height would stretch a 0.78rem pill
  // into something the height of the name itself.
  chk(
    "the badge is pill-sized, not heading-sized",
    m.badge.height <= 30,
    `${m.badge.height}px tall`
  );
  chk(
    "the actions menu is a real tap target",
    m.menu.height >= 44,
    `${m.menu.height}px tall`
  );
  chk("the menu label stays on one line", m.menu.lines === 1, `${m.menu.lines} lines`);
  chk(
    "the menu sits at the right-hand edge",
    Math.abs(m.menu.right - m.containerRight) <= 2,
    `menu ends ${m.menu.right}, container ends ${m.containerRight}`
  );
  // The whole point of replacing four buttons with one: the header is a
  // single row again, so the name keeps its line.
  chk(
    "the header is one row — the menu sits beside the name",
    m.menu.top < m.lastLine.midY + 20,
    `menu top ${m.menu.top}, name last line ${m.lastLine.midY}`
  );

  // "Quotes" and "Job history" are the same kind of thing and have to look it.
  const h = m.headings;
  chk(
    "the two section headings start at the same left margin",
    h.quotes.left === h.job.left,
    `Quotes at ${h.quotes.left}, Job history at ${h.job.left}`
  );
  chk(
    "and are the same size and weight",
    h.quotes.fontSize === h.job.fontSize && h.quotes.fontWeight === h.job.fontWeight,
    `${h.quotes.fontSize}/${h.quotes.fontWeight} vs ${h.job.fontSize}/${h.job.fontWeight}`
  );
  chk(
    "and the same colour",
    h.quotes.color === h.job.color,
    `${h.quotes.color} vs ${h.job.color}`
  );
  chk(
    "and leave the same gap above their content",
    Math.abs(h.quotes.below - h.job.below) <= 1,
    `Quotes ${h.quotes.below}px, Job history ${h.job.below}px`
  );



  await p.screenshot({ path: `verify/shot-mobile-${width}.png`, fullPage: true });
  await p.close();
}

await browser.close();
console.log(bad === 0 ? "\nlayout holds" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
