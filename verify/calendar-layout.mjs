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
 * Monday is the interesting day: two jobs overlapping in time is what makes
 * react-big-calendar lay a column out in two halves, and a half-width block
 * is the one the old CSS pushed into the next day. Tuesday is the ordinary
 * case, and it has to keep working — a fix that stops the spill by making
 * every block half a column wide would be no fix at all.
 *
 * A Wednesday job runs one hour, under the threshold at which the Day view
 * adds an address line. A three-line block inside a 48px box would spill
 * over the hour below it, which is the same class of bug pointed downwards.
 */
const FIXTURE = `
function at(day, hour) {
  return new Date(2026, 8, day, hour, 0, 0).toISOString();
}
function job(id, day, hour, hours, name, status, address, crew) {
  return {
    id: String(id),
    starts_at: at(day, hour),
    duration_hours: hours,
    status,
    customer: { name, address },
    lead: null,
    assignments: (crew || []).map((full_name) => ({ tech: { full_name } })),
  };
}
export const JOBS = [
  // Monday: two at once.
  job(1, 21, 9, 3, "Chris Rule", "completed", "1200 NW Polk Ave, Corvallis, OR", ["Hayden"]),
  job(2, 21, 11, 3, "Trish Roark", "completed", "455 SW Madison Ave, Corvallis, OR", ["Jordan"]),
  // Tuesday: one after another, the ordinary day.
  job(3, 22, 9, 3, "Susan", "completed", "2100 NW Harrison Blvd, Corvallis, OR", ["Jordan"]),
  job(4, 22, 12, 3, "Tom Wolpert", "completed", "780 NW Kings Blvd, Corvallis, OR", []),
  // Wednesday: what the Day view shows, including a short job.
  job(5, 23, 9, 3, "Chris", "scheduled", "300 Benton View Dr, Philomath, OR 97370", ["Jordan", "Hayden"]),
  job(6, 23, 13, 1, "Quick touch-up", "scheduled", "99 SE Crystal Lake Dr, Corvallis, OR", ["Hayden"]),
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

function box(el) {
  const b = el.getBoundingClientRect();
  return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
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

/* ---- week, at a desktop width -------------------------------------------- */

{
  const page = await open("week", 1440);
  const { cols } = await geometry(page);

  ok("the week draws seven day columns", cols.length === 7, `saw ${cols.length}`);

  const monday = cols[1];
  ok("Monday holds both of its jobs", monday.events.length === 2, `saw ${monday.events.length}`);

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
  // which is the thing that made the name unreadable.
  const [a, b] = monday.events;
  ok(
    "THE POINT: Monday's two concurrent jobs are side by side, not stacked",
    a.right <= b.left + 1 || b.right <= a.left + 1,
    `${Math.round(a.left)}–${Math.round(a.right)} and ${Math.round(b.left)}–${Math.round(b.right)}`
  );

  // And the ordinary day still gets the whole column — a fix that halved
  // every block would satisfy everything above and be worse than the bug.
  const tuesday = cols[2];
  for (const e of tuesday.events) {
    ok(
      "a day with no clash gives each job the full column",
      e.w > tuesday.w * 0.8,
      `${Math.round(e.w)}px of ${Math.round(tuesday.w)}px`
    );
  }

  // The width fix. At 900px these columns were ~113px, which is where
  // "Tom Wolpert" wrapped onto two lines and longer names truncated.
  ok(
    "THE POINT: a week column is wide enough for a name at 1440px",
    tuesday.w > 150,
    `${Math.round(tuesday.w)}px`
  );

  // The week block stays a name and a time. The address belongs to the Day
  // view, where there is room for it.
  const weekText = tuesday.events.map((e) => e.text).join(" ");
  ok(
    "the week grid does not try to fit an address into 170px",
    !weekText.includes("NW Harrison"),
    weekText
  );
  ok("the week grid shows the start time only", /9:00 AM(?!\s*–)/.test(weekText), weekText);

  await page.close();
}

/* ---- day, at the same width ---------------------------------------------- */

{
  const page = await open("day", 1440);
  const { cols } = await geometry(page);

  ok("the day draws one column", cols.length === 1, `saw ${cols.length}`);

  const day = cols[0];
  const long = day.events.find((e) => e.text.includes("Chris"));
  const short = day.events.find((e) => e.text.includes("Quick touch-up"));

  ok("the day shows both of Wednesday's jobs", !!long && !!short);

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

  // The day view is deliberately NOT widened — one column means every extra
  // pixel goes into a wider empty rectangle.
  ok(
    "the day column is not stretched across the whole screen",
    day.w < 900,
    `${Math.round(day.w)}px`
  );

  await page.close();
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

  await page.close();
}

await browser.close();

/* --- report ---------------------------------------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);

void box;
