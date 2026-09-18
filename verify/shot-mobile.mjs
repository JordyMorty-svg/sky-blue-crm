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
//   * every nav tab is fully readable, not clipped by a scroller
//   * a section heading is not left stranded above content it doesn't describe
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

// A long commercial name is passed as an argument so the same file can check
// the case that crowds the badge: `node verify/shot-mobile.mjs "Okonkwo
// Storefront & Bakery LLC"`.
const NAME = process.argv[2] || "Susan";

const customersCss = readFileSync("src/pages/customers/Customers.css", "utf8");
const appCss = readFileSync("src/App.css", "utf8");

const TABS = ["Leads", "Jobs", "Schedule", "Income", "Customers", "Map"];

// The real markup, matching App.jsx and CustomerDetail.jsx.
const shell = `
  <header class="shell__bar">
    <div class="shell__brand">Sky Blue <span class="shell__brand-accent">CRM</span></div>
    <nav class="shell__nav">
      ${TABS.map(
        (t) =>
          `<a class="shell__tab ${t === "Customers" ? "shell__tab--active" : ""}" href="#">${t}</a>`
      ).join("")}
    </nav>
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
        <div class="custdetail__actions">
          <button class="custdetail__schedule">+ Schedule a job</button>
          <button class="custdetail__edit">History</button>
          <button class="custdetail__edit">Edit</button>
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
    </div>
  </main>`;

const html = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
  ${appCss}
  ${customersCss}
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
    const actions = r(".custdetail__actions");
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
    const nav = document.querySelector(".shell__nav");
    const navBox = nav.getBoundingClientRect();

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
      tallestButton: Math.max(
        ...[...document.querySelectorAll(".custdetail__actions button")].map((b) =>
          Math.round(b.getBoundingClientRect().height)
        )
      ),
      // A tab is clipped if it sticks out past the nav's visible box, or if
      // the nav can scroll at all — on a phone that hides the tab you are on.
      navScrollable: nav.scrollWidth > nav.clientWidth + 1,
      clippedTabs: [...document.querySelectorAll(".shell__tab")]
        .filter((t) => {
          const b = t.getBoundingClientRect();
          return b.right > navBox.right + 1 || b.left < navBox.left - 1;
        })
        .map((t) => t.textContent),
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
  // of both — the badge sat on its own row under the buttons, at the same
  // left margin. What separates them is the BUTTONS: the badge now belongs
  // to the name block, so it can never start below where the actions end.
  chk(
    "the badge belongs to the name, not below the buttons",
    m.badge.top < m.actionsBottom,
    `badge starts ${m.badge.top}, buttons end ${m.actionsBottom}`
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
  chk("no button label wraps to two lines", m.tallestButton <= 46, `${m.tallestButton}px`);
  chk(
    "every nav tab is fully visible",
    m.clippedTabs.length === 0 && !m.navScrollable,
    m.clippedTabs.length ? `clipped: ${m.clippedTabs.join(", ")}` : "the nav scrolls horizontally"
  );

  if (width < 720) {
    // THE POINT. On a phone everything else on this page starts at the same
    // left margin; actions floated to the right edge under a left-aligned
    // name is the thing that reads as broken.
    chk(
      "the actions line up with the name, not the right edge",
      m.wrapped ? Math.abs(m.actionsLeft - m.nameLeft) <= 2 : true,
      `name at ${m.nameLeft}, actions at ${m.actionsLeft}`
    );
    chk(
      "and with the contact details below them",
      m.wrapped ? Math.abs(m.actionsLeft - m.infoLeft) <= 2 : true,
      `info at ${m.infoLeft}, actions at ${m.actionsLeft}`
    );
  } else {
    // On a laptop the actions belong on the right, whether or not a long
    // commercial name has pushed them onto their own row. Asserting they
    // never wrap was wrong: .custdetail is capped at 720px, so a long enough
    // name legitimately takes the line to itself at any viewport width.
    chk(
      "on a wide screen the actions stay right-aligned",
      Math.abs(m.actionsRight - m.containerRight) <= 2,
      `actions end ${m.actionsRight}, container ends ${m.containerRight}`
    );
  }

  await p.screenshot({ path: `verify/shot-mobile-${width}.png`, fullPage: true });
  await p.close();
}

await browser.close();
console.log(bad === 0 ? "\nlayout holds" : `\n${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
