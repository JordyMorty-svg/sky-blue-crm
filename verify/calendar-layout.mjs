// The calendar grid on a desktop: does every job stay inside its own day?
//
//   node verify/calendar-layout.mjs
//
// This is a LAYOUT suite, so it needs a layout engine — jsdom computes no
// geometry and would have agreed with every broken version of this file.
// The real Schedule page is bundled with its services stubbed, written out
// as a self-contained page, and measured in Chromium.
//
// What it exists to catch
// -----------------------
// react-big-calendar positions a block in a day column with four inline
// values: `top`, `height`, `left` and `width`, the last two as percentages
// worked out so two jobs running at the same hour tile side by side inside
// their own column.
//
// Schedule.css used to set `width: calc(100% - 6px) !important` on every
// event to leave a gap. That overrode the width but could not override the
// `left` sitting next to it — so on a Monday with two jobs at once, the
// second block kept its 50% offset, took the full column's width from
// there, and was drawn 47px into Tuesday, over the job already there.
//
// Nothing errored. The page rendered, the tests that existed passed, and
// the only symptom was a screenshot that looked wrong. So the assertions
// marked THE POINT are all geometric: they measure where a block actually
// lands, which is the only thing that would have noticed.

import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ENTRY = "verify/.calendar-entry.jsx";
const OUT_JS = "verify/.calendar-page.js";
const OUT_CSS = "verify/.calendar-page.css";
const OUT_HTML = "verify/.calendar-page.html";

/* --- the week under test ---------------------------------------------------
 *
 * Every date is derived from TODAY, because the calendar opens on today and
 * a fixture pinned to a literal week stops testing anything the moment that
 * week passes — it would still run, still pass, and be looking at an empty
 * grid. An earlier version of this file was pinned to 21-23 September 2026
 * and had about four days of life left in it.
 *
 * Today carries the two jobs the Day view is about: one three-hour job, and
 * one of an hour, which is under the threshold where the block gains an
 * address line. Neither overlaps the other, so today is also the ordinary
 * case for the week grid — every block gets its whole column.
 *
 * A neighbouring day carries two jobs running at the same time. That is what
 * makes react-big-calendar split a column in half, and a half-width block is
 * the one the old CSS pushed into the next day. It sits beside today rather
 * than on it, and steps backwards instead of forwards in the one case where
 * forwards would fall out of the week.
 */
const FIXTURE = `
const today = new Date();

// Saturday is the last column, so its neighbour has to be the day before.
const NEIGHBOUR = today.getDay() === 6 ? -1 : 1;

function at(offsetDays, hour) {
  const d = new Date(today);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function job(id, offset, hour, hours, name, status, address, crew) {
  return {
    id: String(id),
    starts_at: at(offset, hour),
    duration_hours: hours,
    status,
    customer: { name, address },
    lead: null,
    assignments: (crew || []).map((full_name) => ({ tech: { full_name } })),
  };
}

export const JOBS = [
  // Today. Three hours, then one hour, back to back but never at once.
  job(1, 0, 9, 3, "Chris", "scheduled", "300 Benton View Dr, Philomath, OR 97370", ["Jordan", "Hayden"]),
  job(2, 0, 13, 1, "Quick touch-up", "completed", "99 SE Crystal Lake Dr, Corvallis, OR", ["Hayden"]),
  // Next door. Two crews out at the same time.
  job(3, NEIGHBOUR, 9, 3, "Chris Rule", "completed", "1200 NW Polk Ave, Corvallis, OR", ["Hayden"]),
  job(4, NEIGHBOUR, 11, 3, "Trish Roark", "completed", "455 SW Madison Ave, Corvallis, OR", ["Jordan"]),
];
`;

writeFileSync("verify/.calendar-fixture.js", FIXTURE);

writeFileSync(
  ENTRY,
  `import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Schedule from "../src/pages/schedule/Schedule";
import "../src/index.css";

createRoot(document.getElementById("root")).render(
  <MemoryRouter initialEntries={["/schedule/calendar"]}>
    <Routes>
      <Route path="/schedule/*" element={<Schedule />} />
    </Routes>
  </MemoryRouter>
);
`
);

/* --- bundle, with everything that talks to Supabase replaced --------------- */

function stub(filter, contents) {
  return { filter, contents };
}

const STUBS = [
  stub(/context\/useAuth$/, `export function useAuth() { return { user: { id: "verify" }, role: "admin" }; }`),
  stub(/components\/capabilities$/, `export function can() { return true; }`),
  stub(/services\/jobService$/, `export async function fetchMyJobs() { return []; }`),
  stub(
    /services\/calendarService$/,
    `import { JOBS } from "./.calendar-fixture.js";
     export async function fetchCalendarJobs() { return JOBS; }`
  ),
  // Pulled in by JobPlanTag, and it only needs to not explode.
  stub(/services\/leadService$/, `export function planFor() { return null; }`),
  // navigation.js reaches into the Square helper purely for platform sniffing.
  stub(/squarePos$/, `export function isIOS() { return false; } export function isAndroid() { return false; }`),
];

const stubPlugin = {
  name: "stubs",
  setup(b) {
    for (const [i, s] of STUBS.entries()) {
      const ns = `stub${i}`;
      b.onResolve({ filter: s.filter }, (a) => ({ path: a.path, namespace: ns }));
      b.onLoad({ filter: /.*/, namespace: ns }, () => ({
        contents: s.contents,
        loader: "js",
        resolveDir: join(process.cwd(), "verify"),
      }));
    }
  },
};

await build({
  entryPoints: [join(process.cwd(), ENTRY)],
  bundle: true,
  // iife, not esm: the page is opened over file://, where a module script is
  // blocked as a cross-origin request and never runs at all.
  format: "iife",
  jsx: "automatic",
  outfile: OUT_JS,
  plugins: [stubPlugin],
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  logLevel: "warning",
});

writeFileSync(
  OUT_HTML,
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./.calendar-page.css">
</head><body><div id="root"></div>
<script src="./.calendar-page.js"></script></body></html>`
);

/* --- measure --------------------------------------------------------------- */

let passed = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
});

async function open(view, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const crashes = [];
  page.on("pageerror", (e) => crashes.push(String(e)));
  await page.goto(`file://${join(process.cwd(), OUT_HTML)}`);
  await page.waitForSelector(".rbc-calendar", { timeout: 10000 });
  await page.getByRole("button", { name: new RegExp(`^${view}$`, "i") }).click();
  await page.waitForTimeout(250);
  if (crashes.length) {
    // A blank page passes every geometric assertion vacuously, so say so
    // loudly and stop rather than reporting a hundred green ticks.
    console.error("The page threw before anything could be measured:\n", crashes[0]);
    process.exit(1);
  }
  return page;
}

async function geometry(page) {
  return page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
    };
    const cols = [...document.querySelectorAll(".rbc-time-content .rbc-day-slot")].map((c) => ({
      ...r(c),
      events: [...c.querySelectorAll(".rbc-event")].map((e) => ({
        text: e.textContent.trim(),
        ...r(e),
      })),
    }));
    return { cols };
  });
}

// What a "completed" block actually looks like once the browser has resolved
// every rule that claims a piece of it. Read rather than assumed, because the
// bug this catches was one rule quietly overriding another.
async function lookOfADoneEvent(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll(".rbc-event")].find((e) =>
      e.className.includes("calevent--done")
    );
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      color: s.color,
      radius: s.borderTopLeftRadius,
      // The outline. An inset ring, so that trimming for a gap can't cut it.
      shadow: s.boxShadow,
      // Anything other than "none" here means part of the block isn't being
      // drawn — which is exactly how Week ended up with half an outline.
      clip: s.clipPath,
      padding: s.padding,
      fontSize: s.fontSize,
    };
  });
}

// The card the calendar sits in. Pressing a view tab must not resize it.
async function cardWidth(page) {
  return page.evaluate(() =>
    Math.round(document.querySelector(".schedule__calendar").getBoundingClientRect().width)
  );
}

/* ---- week, at a desktop width -------------------------------------------- */

const look = {};
const cards = {};

{
  const page = await open("week", 1440);
  const { cols } = await geometry(page);
  look.week = await lookOfADoneEvent(page);
  cards.week = await cardWidth(page);

  ok("the week draws seven day columns", cols.length === 7, `saw ${cols.length}`);

  // Which columns hold what is worked out from the grid, not assumed: the
  // fixture is anchored to today, so which weekday a job lands on depends on
  // when the suite is run.
  const withJobs = cols.filter((c) => c.events.length > 0);
  ok("two days of the week have work on them", withJobs.length === 2, `saw ${withJobs.length}`);

  function clash(a, b) {
    // Blocks that share any vertical space are jobs running at the same time.
    return a.top < b.bottom - 1 && b.top < a.bottom - 1;
  }

  // THE POINT. The old rule let the second of two concurrent jobs run past
  // the right-hand edge of its own day, into the next one.
  for (const c of cols) {
    for (const e of c.events) {
      ok(
        `THE POINT: "${e.text.split("\n")[0]}" stays inside its day column`,
        e.left >= c.left - 1 && e.right <= c.right + 1,
        `event ${Math.round(e.left)}–${Math.round(e.right)} vs column ${Math.round(c.left)}–${Math.round(c.right)}`
      );
    }
  }

  // THE POINT. Staying inside the column is not enough on its own: two
  // blocks could both be inside it and still be drawn on top of each other,
  // which is what made the name unreadable.
  let clashes = 0;
  for (const c of cols) {
    for (let i = 0; i < c.events.length; i += 1) {
      for (let j = i + 1; j < c.events.length; j += 1) {
        const a = c.events[i];
        const b = c.events[j];
        if (!clash(a, b)) continue;
        clashes += 1;
        ok(
          "THE POINT: two jobs at the same hour are side by side, not stacked",
          a.right <= b.left + 1 || b.right <= a.left + 1,
          `${Math.round(a.left)}–${Math.round(a.right)} and ${Math.round(b.left)}–${Math.round(b.right)}`
        );
      }
    }
  }

  // Without this the loop above is satisfied by a week with nothing to lay
  // out, which is exactly the state a stale fixture leaves behind.
  ok("the week actually contains a clash to lay out", clashes === 1, `saw ${clashes}`);

  // And a job with nothing running against it still gets the whole column —
  // a fix that halved every block would satisfy everything above and be
  // worse than the bug.
  let solos = 0;
  for (const c of cols) {
    for (const e of c.events) {
      if (c.events.some((o) => o !== e && clash(o, e))) continue;
      solos += 1;
      ok(
        "a job with no clash gets the full column",
        e.w > c.w * 0.8,
        `${Math.round(e.w)}px of ${Math.round(c.w)}px`
      );
    }
  }
  ok("and the week contains one of those too", solos === 2, `saw ${solos}`);

  // The width fix. At 900px these columns were ~113px, which is where
  // "Tom Wolpert" wrapped onto two lines and longer names truncated.
  ok(
    "THE POINT: a week column is wide enough for a name at 1440px",
    cols[0].w > 150,
    `${Math.round(cols[0].w)}px`
  );

  // The week block stays a name and a time. The address belongs to the Day
  // view, where there is room for it.
  const weekText = cols.flatMap((c) => c.events.map((e) => e.text)).join(" ");
  ok(
    "the week grid does not try to fit an address into 170px",
    !weekText.includes("Benton View"),
    weekText
  );
  ok("the week grid shows the start time only", !weekText.includes("–"), weekText);

  await page.close();
}

/* ---- day, at the same width ---------------------------------------------- */

{
  const page = await open("day", 1440);
  const { cols } = await geometry(page);
  look.day = await lookOfADoneEvent(page);
  cards.day = await cardWidth(page);

  ok("the day draws one column", cols.length === 1, `saw ${cols.length}`);

  const day = cols[0];
  const long = day.events.find((e) => e.text.includes("Chris"));
  const short = day.events.find((e) => e.text.includes("Quick touch-up"));

  ok("the day shows both of today's jobs", !!long && !!short, day.events.map((e) => e.text).join(" | "));

  // THE POINT. The complaint that started this: a three-hour job in Day view
  // is a full-width, 144px-tall rectangle, and it held a name and nothing
  // else. Whatever else changes, the block has to say something.
  ok(
    "THE POINT: a tall day block carries the address",
    long.text.includes("300 Benton View Dr"),
    long.text
  );
  ok("THE POINT: a tall day block carries the crew", long.text.includes("Jordan"), long.text);
  ok(
    "THE POINT: the day view shows when the job finishes, not just when it starts",
    long.text.includes("9:00 AM – 12:00 PM"),
    long.text
  );

  // THE POINT, pointed the other way. An hour is 48px: a name, an address
  // and a crew line do not fit, and text that overflows a block lands on
  // top of the hour underneath it.
  ok(
    "THE POINT: a one-hour block keeps the name alone",
    !short.text.includes("Crystal Lake"),
    short.text
  );

  await page.close();
}

/* ---- month, and then the three views against each other ------------------- */

{
  const page = await open("month", 1440);
  look.month = await lookOfADoneEvent(page);
  cards.month = await cardWidth(page);
  await page.close();
}

{
  ok("a completed block was found in every view", !!look.day && !!look.week && !!look.month, JSON.stringify(look));

  // THE POINT. Pressing a view tab used to resize the card: Day was held at
  // 900px while Week and Month went to 1360, so the whole page jumped when
  // you switched. The tabs change what's in the frame, not the frame.
  ok(
    "THE POINT: the card is the same width in all three views",
    cards.day === cards.week && cards.week === cards.month,
    JSON.stringify(cards)
  );

  // THE POINT. The same job has to look the same whichever view you're in.
  // It didn't: a clip-path meant to leave a gap trimmed the right and bottom
  // off the block in Day and Week, taking the outline and the drop shadow
  // with it — so Month, the only view drawing the block completely, read as
  // the darker one.
  for (const prop of ["background", "color", "radius", "shadow", "padding", "fontSize"]) {
    ok(
      `THE POINT: a finished job's ${prop} is the same in Day, Week and Month`,
      look.day?.[prop] === look.week?.[prop] && look.week?.[prop] === look.month?.[prop],
      `day ${look.day?.[prop]} | week ${look.week?.[prop]} | month ${look.month?.[prop]}`
    );
  }

  // THE POINT, at the mechanism. Equal computed values above could still be
  // equal-and-both-clipped; this is the one that says the whole block is
  // drawn, outline included.
  for (const view of ["day", "week", "month"]) {
    ok(
      `THE POINT: nothing is trimmed off the block in ${view}`,
      look[view]?.clip === "none",
      look[view]?.clip
    );
  }

  // And the outline is a ring inside the box, which is what makes it
  // survivable: a border would have to fight the inline sizing.
  ok(
    "the outline is an inset ring, not a border",
    look.week?.shadow?.includes("inset"),
    look.week?.shadow
  );
}

/* ---- the phone, which must not have changed ------------------------------- */

{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`file://${join(process.cwd(), OUT_HTML)}`);
  await page.waitForSelector(".rbc-custom-toolbar", { timeout: 10000 });
  await page.getByRole("button", { name: /^week$/i }).click();
  await page.waitForTimeout(250);

  const list = await page.$(".weeklist");
  ok("a phone still gets the week as a list, not a grid", !!list);

  const spill = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1
  );
  ok("nothing pushes the page sideways on a phone", !spill);

  // Month is the one grid that survives a phone, and its chips are 20px tall
  // and stacked with no vertical margin — so their outline is the only thing
  // separating one job from the next. A `box-shadow: none` left over from
  // when the outline was a drop shadow turned four jobs in a day into one
  // solid block of green.
  await page.getByRole("button", { name: /^month$/i }).click();
  await page.waitForTimeout(250);
  const chip = await page.evaluate(() => {
    const el = document.querySelector(".rbc-month-view .rbc-event");
    return el ? getComputedStyle(el).boxShadow : null;
  });
  ok("THE POINT: a month chip keeps its outline on a phone", !!chip && chip.includes("inset"), chip);

  await page.close();
}

await browser.close();

/* --- report ---------------------------------------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
