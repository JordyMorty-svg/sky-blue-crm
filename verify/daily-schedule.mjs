// The daily schedule: does a job you've finished stay on the day?
//
//   node verify/daily-schedule.mjs
//
// The complaint
// -------------
// Mark a job completed and it vanished off the day. `fetchMyJobs` defaults
// to `status: "scheduled"`, and the daily list took the default — so the
// list emptied itself as the crew worked through it. By mid-afternoon a
// finished day looked exactly like a day with nothing booked, and there was
// no way to check what had already been done without going to find it.
//
// Nothing errored, which is why this needs assertions rather than eyes: the
// page rendered perfectly, it was just missing the work.
//
// What "checked off" has to mean
// ------------------------------
// Still there, visibly done, and NOT still offering the actions that only
// make sense beforehand. "Mark completed" on something already completed is
// a trap, and the editor would let you rewrite the price of work that has a
// Square payment behind it — its record is read-only for that reason.
//
// The assertions marked THE POINT are the ones that would have caught the
// original, or that catch a half-fix: showing the job again but leaving the
// buttons alone would be worse than the bug.

import { build } from "esbuild";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/* --- stubs ---------------------------------------------------------------- */

// Every navigate(), and the options the page passed to fetchMyJobs, so the
// assertions can ask what was requested rather than infer it.
const ROUTER = `
  import { createElement } from "react";
  export function useNavigate() {
    return (to, opts) => globalThis.__trips.push({ to, state: opts?.state });
  }
  export function useLocation() { return { pathname: "/schedule", state: null }; }
  export function NavLink({ children }) { return createElement("a", null, children); }
  export function Link({ children }) { return createElement("a", null, children); }
`;

const JOB_SERVICE = `
  import { MY_JOBS } from "./.daily-fixture.js";
  export async function fetchMyJobs(techId, opts) {
    globalThis.__asked = opts ?? null;
    const wanted = opts?.statuses?.length ? opts.statuses : [opts?.status ?? "scheduled"];
    // Behaves like the real query: it returns what was asked for and nothing
    // else, so a page that forgets to ask gets a day with holes in it.
    return MY_JOBS.filter((j) => wanted.includes(j.status));
  }
`;

const STUBS = [
  [/^react-router-dom$/, ROUTER],
  [/context\/useAuth$/, `export function useAuth() { return { user: { id: "v" }, role: "admin" }; }`],
  [/components\/capabilities$/, `export function can() { return true; }`],
  [/services\/jobService$/, JOB_SERVICE],
  [/services\/calendarService$/, `export async function fetchCalendarJobs() { return []; }`],
  [/services\/leadService$/, `export function planFor() { return null; }`],
  [/squarePos$/, `export function isIOS() { return false; } export function isAndroid() { return false; }`],
  // react-big-calendar is CommonJS and does `require("react")`, which an ESM
  // bundle with react left external cannot satisfy. It is also not what this
  // suite is about: the daily view never renders it, and the calendar view
  // has a suite of its own that renders the real thing in a real browser.
  [
    /^react-big-calendar$/,
    `export function Calendar() { return null; }
     export function dateFnsLocalizer() { return {}; }`,
  ],
];

const plugin = {
  name: "stubs",
  setup(b) {
    for (const [i, [filter, contents]] of STUBS.entries()) {
      const ns = `s${i}`;
      b.onResolve({ filter }, (a) => ({ path: a.path, namespace: ns }));
      b.onLoad({ filter: /.*/, namespace: ns }, () => ({
        contents,
        loader: "js",
        resolveDir: join(process.cwd(), "verify"),
      }));
    }
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
    b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  },
};

/* --- the day under test ----------------------------------------------------
 *
 * Two done, one to go, and the done ones are FIRST — a day is a timeline, and
 * sorting finished work to the bottom would answer "what's left?" at the cost
 * of "where am I up to?". The 9am job was quoted at 180 and charged 210,
 * which is the ordinary case of a customer adding gutters on the day. */

import { writeFileSync } from "node:fs";

writeFileSync(
  "verify/.daily-fixture.js",
  `const today = new Date();
function at(hour) {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, 0, 0).toISOString();
}
export const MY_JOBS = [
  { id: "a", starts_at: at(9), duration_hours: 3, status: "completed",
    price: 180, final_price: 210, notes: "Gate code 1420.", service_plan: "one_time",
    customer: { id: "c1", name: "Chris", address: "300 Benton View Dr", phone: "5419285050" },
    lead: null, assignments: [{ tech: { full_name: "Hayden" } }] },
  { id: "b", starts_at: at(12), duration_hours: 3, status: "completed",
    price: 140, final_price: null, notes: null, service_plan: "one_time",
    customer: { id: "c2", name: "Cece", address: "1530 NW 9th St", phone: "5415550000" },
    lead: null, assignments: [] },
  { id: "c", starts_at: at(15), duration_hours: 3, status: "scheduled",
    price: 220, final_price: null, notes: null, service_plan: "one_time",
    customer: { id: "c3", name: "Lisa Petermen", address: "32483 Oakville Rd SW", phone: "5415173362" },
    lead: null, assignments: [] },
  // Cancelled, today, and it must not come back. Cancelling a job is how it
  // comes OFF the schedule; a fix that showed everything would undo that.
  { id: "d", starts_at: at(17), duration_hours: 2, status: "cancelled",
    price: 90, final_price: null, notes: null, service_plan: "one_time",
    customer: { id: "c4", name: "Called off", address: "1 Nowhere", phone: "5415550001" },
    lead: null, assignments: [] },
];
`
);

const out = "verify/.daily-schedule-bundle.mjs";

await build({
  entryPoints: [join(process.cwd(), "src/pages/schedule/Schedule.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile: out,
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
  plugins: [plugin],
  logLevel: "warning",
});

/* --- a DOM ---------------------------------------------------------------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__trips = [];

// react-big-calendar is imported by the page even on the daily view, and it
// reads matchMedia on the way in. jsdom has no media engine.
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
}

const { createRoot } = await import("react-dom/client");
const { act, createElement } = await import("react");
const Schedule = (await import("./.daily-schedule-bundle.mjs")).default;

const host = document.createElement("div");
document.body.appendChild(host);
await act(async () => {
  createRoot(host).render(createElement(Schedule));
});

/* --- assertions ----------------------------------------------------------- */

let passed = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

function textOf(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

async function click(el) {
  if (!el) return;
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

const cards = [...host.querySelectorAll(".schedjob")];

// If the page never rendered, every assertion below passes by saying nothing
// is wrong with nothing. Stop instead.
if (cards.length === 0) {
  console.error("No job cards rendered at all — the page didn't load.");
  console.error(host.innerHTML.slice(0, 600));
  process.exit(1);
}

// THE POINT, at the source. The daily list took `fetchMyJobs`'s default,
// which is "scheduled" — this is the line that made finished work disappear.
ok(
  "THE POINT: the day asks for completed work as well as booked",
  globalThis.__asked?.statuses?.includes("completed") &&
    globalThis.__asked?.statuses?.includes("scheduled"),
  JSON.stringify(globalThis.__asked)
);

// And not for everything. Cancelling a job is how it leaves the schedule.
ok(
  "THE POINT: it does not ask for cancelled work",
  !globalThis.__asked?.statuses?.includes("cancelled"),
  JSON.stringify(globalThis.__asked)
);
ok(
  "so a cancelled job is not on the day",
  !textOf(host).includes("Called off"),
  textOf(host).slice(0, 200)
);

// THE POINT. The complaint itself.
ok("THE POINT: three jobs on the day, not one", cards.length === 3, `saw ${cards.length}`);
ok("THE POINT: the finished 9am job is still there", textOf(host).includes("Chris"));

// A day is a timeline. Sorting finished work to the bottom would answer
// "what's left?" at the cost of "where am I up to?".
ok(
  "the day is still in time order",
  textOf(cards[0]).includes("9:00 AM") && textOf(cards[2]).includes("3:00 PM"),
  cards.map((c) => textOf(c).slice(0, 12)).join(" | ")
);

// A missing card is a real outcome — it's the bug this suite exists for. A
// stray element keeps the run going so every assertion is reported by name
// instead of the first one throwing and hiding the other twenty.
const MISSING = document.createElement("div");
const doneCard = cards[0] ?? MISSING;
const liveCard = cards[2] ?? MISSING;

ok("THE POINT: the finished job is marked done", doneCard.classList.contains("schedjob--done"));
ok("THE POINT: with a tick", !!doneCard.querySelector(".schedjob__tick"));
ok("the one still to do is not", !liveCard.classList.contains("schedjob--done"));

// A tick is a shape. A screen reader needs the word.
ok(
  "THE POINT: and the word 'completed' for anyone not looking at it",
  textOf(doneCard).toLowerCase().includes("completed"),
  textOf(doneCard).slice(0, 120)
);

// THE POINT. Showing the job again but leaving its buttons alone would be
// worse than the bug: "Mark completed" on completed work is a trap.
ok(
  "THE POINT: a finished job offers no 'Mark completed'",
  !doneCard.querySelector(".schedjob__complete"),
  textOf(doneCard.querySelector(".schedjob__actions"))
);
ok(
  "and no directions to a house you've left",
  !doneCard.querySelector(".schedjob__nav"),
  textOf(doneCard.querySelector(".schedjob__actions"))
);
ok(
  "the one still to do keeps all three",
  !!liveCard.querySelector(".schedjob__complete") &&
    !!liveCard.querySelector(".schedjob__nav") &&
    !!liveCard.querySelector(".schedjob__edit")
);

// THE POINT. The editor would let you rewrite the price of work that has a
// payment behind it. The record is read-only for exactly that reason.
globalThis.__trips.length = 0;
await click(doneCard.querySelector(".schedjob__actions button"));
ok(
  "THE POINT: a finished job opens its record, not the editor",
  globalThis.__trips.at(-1)?.to === "/jobs/record/a",
  JSON.stringify(globalThis.__trips.at(-1))
);
ok(
  "and it's told how to get back to the schedule",
  globalThis.__trips.at(-1)?.state?.from === "/schedule",
  JSON.stringify(globalThis.__trips.at(-1)?.state)
);

globalThis.__trips.length = 0;
await click(liveCard.querySelector(".schedjob__edit"));
ok(
  "a job still to do opens the editor",
  globalThis.__trips.at(-1)?.to === "/jobs/c",
  JSON.stringify(globalThis.__trips.at(-1))
);

// What they actually paid, not what we guessed. The quote is overtaken the
// moment the job is done, and "what did we charge them?" is asked on the way
// to the next house.
ok(
  "THE POINT: a finished job shows what was charged, not what was quoted",
  textOf(doneCard).includes("$210") && !textOf(doneCard).includes("$180"),
  textOf(doneCard)
);
ok(
  "falling back to the quote when nothing else was recorded",
  textOf(cards[1]).includes("$140"),
  textOf(cards[1])
);

// The payoff of keeping finished work on the day.
ok(
  "THE POINT: the day says how far through it you are",
  textOf(host).includes("2 of 3 done"),
  textOf(host).slice(0, 160)
);

// Everything the job knew is still on the card. "What did we charge them"
// and "what was the gate code" both get asked after the fact.
ok("the address survives being done", textOf(doneCard).includes("300 Benton View Dr"));
ok("so do the notes", textOf(doneCard).includes("Gate code 1420"));
ok("and the phone is still a tel: link", !!doneCard.querySelector(".schedjob__phone"));

/* --- and the real service, not the stub ------------------------------------
 *
 * Everything above runs against a stubbed `fetchMyJobs`, which means it
 * asserts what the PAGE asks for and takes on trust that the service honours
 * it. That trust was misplaced once already: a version of `fetchMyJobs` that
 * accepted `statuses` and then quietly ignored it passed every assertion
 * above, because the stub was doing the honouring.
 *
 * So the real thing is bundled with only Supabase replaced — by a recorder —
 * and asked what it actually puts in the query. Same discipline as the
 * website's address suite: assert on what reaches the database. */

{
  const calls = [];
  const SUPABASE = `
    function builder(table) {
      const b = {
        table,
        then(resolve) {
          // job_assignments resolves to one assignment; jobs resolves to
          // nothing, because what is being measured is the QUERY, not the rows.
          const data = table === "job_assignments" ? [{ job_id: "a" }] : [];
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      for (const m of ["select", "eq", "in", "order", "not", "single", "update"]) {
        b[m] = (...args) => {
          globalThis.__q.push({ table, method: m, args });
          return b;
        };
      }
      return b;
    }
    export const supabase = { from: (table) => builder(table) };
  `;

  const realOut = "verify/.daily-service-bundle.mjs";
  await build({
    entryPoints: [join(process.cwd(), "src/services/jobService.js")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: realOut,
    plugins: [
      {
        name: "supa",
        setup(b) {
          b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
          b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({ contents: SUPABASE, loader: "js" }));
        },
      },
    ],
    logLevel: "warning",
  });

  globalThis.__q = calls;
  const real = await import("./.daily-service-bundle.mjs");
  await real.fetchMyJobs("tech-1", { statuses: ["scheduled", "completed"] });

  const statusFilter = calls.find((c) => c.table === "jobs" && c.method === "in" && c.args[0] === "status");

  ok("the service filters jobs by status at all", !!statusFilter, JSON.stringify(calls.slice(-4)));
  ok(
    "THE POINT: `statuses` reaches the query, rather than being accepted and ignored",
    Array.isArray(statusFilter?.args[1]) &&
      statusFilter.args[1].includes("scheduled") &&
      statusFilter.args[1].includes("completed"),
    JSON.stringify(statusFilter?.args)
  );

  // The old single-status callers must keep working — the default is what
  // every other page relies on, and widening it here would change them all.
  calls.length = 0;
  await real.fetchMyJobs("tech-1");
  const fallback = calls.find((c) => c.table === "jobs" && c.method === "in" && c.args[0] === "status");
  ok(
    "and with nothing passed, it still means 'scheduled' and only that",
    JSON.stringify(fallback?.args[1]) === JSON.stringify(["scheduled"]),
    JSON.stringify(fallback?.args)
  );
}

/* --- report ---------------------------------------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
