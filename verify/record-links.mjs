// Getting between a job and the customer behind it, and back again.
//
//   node verify/record-links.mjs
//
// Three complaints, one shape
// ---------------------------
// 1. Open a customer, press Edit, press back — and you were on the customer
//    list. The edit form is the same page with its fields opened up, so back
//    should close the form, not leave the person you were editing.
//
// 2. A job showed the customer's address and phone in a card that went
//    nowhere. Everything the card doesn't say — the gate code, the plan,
//    what they paid last time — is one page away and had no door.
//
// 3. Having walked Calendar -> job -> customer, back has to walk all the way
//    home: customer -> job -> calendar. A job's own return path lives in its
//    router state, so the customer page has to carry it and hand it back.
//
// None of this throws when it's wrong. Every broken version renders, and the
// only symptom is arriving somewhere you didn't ask for — so the assertions
// below are about WHERE a press lands, and the ones marked THE POINT are the
// three complaints themselves.
//
// Runs the real components in jsdom with the services and the router's
// navigate() stubbed at bundle time. Nothing here touches the network.

import { build } from "esbuild";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/* --- stubs ---------------------------------------------------------------- */

// Every navigate() the pages make, in order, so an assertion can ask where
// the last press went rather than guessing from the DOM.
const TRIPS = [];

const ROUTER = `
  import { createElement } from "react";
  export function useNavigate() {
    return (to, opts) => globalThis.__trips.push({ to, state: opts?.state });
  }
  export function useParams() { return { id: globalThis.__routeId ?? "c1" }; }
  export function useLocation() { return globalThis.__location; }
  export function Link({ children }) { return createElement("a", null, children); }
  export function NavLink({ children }) { return createElement("a", null, children); }
`;

const NOOP_COMPONENT = `
  export default function Stub() { return null; }
`;

function stubs(map) {
  return {
    name: "stubs",
    setup(b) {
      for (const [i, [filter, contents]] of map.entries()) {
        const ns = `s${i}`;
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: ns }));
        b.onLoad({ filter: /.*/, namespace: ns }, () => ({ contents, loader: "js" }));
      }
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
      b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

// The customer and job records the pages are handed. Deliberately sparse:
// these suites are about navigation, and a field that isn't read can't be
// the reason an assertion passes.
const CUSTOMER = `
  export async function fetchCustomer() {
    return {
      customer: { id: "c1", name: "Lisa Petermen", phone: "5415173362",
                  email: "llp762@example.com", address: "32483 Oakville Rd SW, Albany, OR",
                  property_type: "residential", service_plan: "one_time", notes: "" },
      jobs: [],
      leadNotes: [],
    };
  }
  export async function updateCustomer() {}
  export async function deleteCustomer() { return { deleted: true }; }
  export async function applyPlanFromJob() {}
`;

const JOBS = `
  export async function fetchJob() { return globalThis.__job; }
  export async function fetchJobRecord() { return globalThis.__job; }
  export async function fetchTechs() { return []; }
  export async function fetchNextVisit() { return null; }
  export async function ensureNextVisit() { return { created: false }; }
  export async function updateJob() {}
  export async function updateJobTechs() {}
  export async function deleteJob() {}
  export async function setJobPlan() {}
  export async function cancelJob() {}
  export async function restoreJob() {}
  export async function fetchJobEvents() { return []; }
  export const RECURRING_LEAD_TIME_DAYS = 14;
`;

const LEAD_SERVICE = `
  export const PROPERTY_TYPES = [{ key: "residential", label: "Residential" }];
  export const SERVICE_PLANS = [{ key: "one_time", label: "One-time" }];
  export function planFor() { return null; }
  export function nextVisitDate() { return null; }
  export function priceForVisit() { return 0; }
  export function telHref(p) { return "tel:" + p; }
  export function formatPhone(p) { return p; }
`;

const COMMON = [
  [/^react-router-dom$/, ROUTER],
  [/services\/customerService$/, CUSTOMER],
  [/services\/jobService$/, JOBS],
  [/services\/calendarService$/, `export async function updateJobTiming() {}`],
  [/services\/invoiceService$/, `export async function refreshInvoiceOnJob() { return null; }`],
  [/services\/leadService$/, LEAD_SERVICE],
  [/services\/contactService$/, `export async function recordContact() {}`],
  [/services\/followUpService$/, `export async function setEmailOptOut() {} export async function setCustomerReviewed() {}`],
  [/services\/quoteService$/, `export async function fetchQuotes() { return []; }`],
  // Child components: each one is a page of its own concerns, and none of
  // them decides where a press lands.
  // RecordMenu is deliberately NOT stubbed: Edit is behind it, and the
  // complaint this suite exists for starts with pressing Edit.
  [/components\/(AddressPicker|JobPlanTag|QuotesPanel|PlanPicker|AppointmentPicker|TechPicker|ServicePicker|JobHistory|FollowUpNotice)$/, NOOP_COMPONENT],
];

async function bundle(entry, out) {
  await build({
    entryPoints: [join(process.cwd(), entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: out,
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    plugins: [stubs(COMMON)],
    logLevel: "warning",
  });
  return import(`./${out.split("/").pop()}`);
}

/* --- a DOM ---------------------------------------------------------------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Getter-only on Node 22, so it has to be defined rather than assigned.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__trips = TRIPS;

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { createElement } = await import("react");

async function mount(Component) {
  // A fresh container each time: reusing one warns about creating a second
  // root on the same node, and the warning is noise that hides real ones.
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Component));
  });
  return { host, root };
}

function textOf(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function findByText(host, selector, text) {
  return [...host.querySelectorAll(selector)].find((el) => textOf(el).includes(text));
}

// Missing rather than unclickable is a real outcome — a control that was
// removed. Throwing here would end the run with a stack trace instead of a
// named failure, and a stack trace says nothing about which promise broke.
async function click(el) {
  if (!el) return;
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

/* --- assertions ----------------------------------------------------------- */

let passed = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

/* ---- the customer page ---------------------------------------------------- */

const customerMod = await bundle(
  "src/pages/customers/CustomerDetail.jsx",
  "verify/.customer-detail-bundle.mjs"
);
const CustomerDetail = customerMod.default;

// Reached the ordinary way, from the customer list.
{
  globalThis.__location = { pathname: "/customers/c1", state: null };
  TRIPS.length = 0;
  const { host } = await mount(CustomerDetail);

  const back = host.querySelector(".custdetail__back");
  ok("the customer page has a back control", !!back);
  ok("from the list, back says so", textOf(back) === "← Back to customers", textOf(back));

  await click(back);
  ok("from the list, back goes to the list", TRIPS.at(-1)?.to === "/customers", JSON.stringify(TRIPS.at(-1)));
}

// The complaint that started this: open a customer, press Edit, press back.
{
  globalThis.__location = { pathname: "/customers/c1", state: null };
  TRIPS.length = 0;
  const { host } = await mount(CustomerDetail);

  ok("the edit form is closed to begin with", !host.querySelector(".custedit"));

  await click(host.querySelector(".recmenu__button"));
  const editItem = findByText(host, "[role=menuitem]", "Edit");
  ok("Edit is in the actions menu", !!editItem);
  await click(editItem);

  ok("pressing Edit opens the form", !!host.querySelector(".custedit"));

  const back = host.querySelector(".custdetail__back");

  // THE POINT, part one. The label is the promise; part two is whether it
  // keeps it. "← Back to customers" while you are mid-edit is the CRM
  // telling you it is about to throw your work on the floor.
  ok(
    "THE POINT: while editing, back names the customer",
    textOf(back) === "← Back to Lisa Petermen",
    textOf(back)
  );

  await click(back);

  // THE POINT, part two. Nothing navigated: the form closed and the customer
  // is still on screen.
  ok("THE POINT: back from the edit form navigates nowhere", TRIPS.length === 0, JSON.stringify(TRIPS));
  ok("THE POINT: it closes the form instead", !host.querySelector(".custedit"));
  ok(
    "THE POINT: leaving you on the customer you were editing",
    textOf(host).includes("Lisa Petermen"),
    textOf(host).slice(0, 120)
  );

  // And once the form is shut, back means what it used to mean again.
  const backAgain = host.querySelector(".custdetail__back");
  ok("with the form closed, back points at the list again", textOf(backAgain) === "← Back to customers", textOf(backAgain));
  await click(backAgain);
  ok("and now it goes there", TRIPS.at(-1)?.to === "/customers", JSON.stringify(TRIPS.at(-1)));
}

/* ---- the job page --------------------------------------------------------- */

const jobMod = await bundle("src/pages/jobs/JobDetail.jsx", "verify/.job-detail-bundle.mjs");
const JobDetail = jobMod.default;

// A job with a customer behind it, opened from the calendar.
{
  globalThis.__job = {
    id: "j1",
    customer_id: "c1",
    status: "scheduled",
    starts_at: new Date(2026, 8, 23, 9, 0).toISOString(),
    duration_hours: 3,
    price: 180,
    notes: "",
    services: "Gutter cleaning",
    service_keys: [],
    customer: { id: "c1", name: "Chris", address: "300 Benton View Dr", phone: "5419285050" },
    lead: null,
    assignments: [],
  };
  globalThis.__location = { pathname: "/jobs/j1", state: { from: "/schedule/calendar" } };
  TRIPS.length = 0;

  const { host } = await mount(JobDetail);

  const card = host.querySelector(".jobDetail__lead");
  ok("the job shows its customer card", !!card, host.innerHTML.slice(0, 200));

  // THE POINT. The card used to be a <div> — information with no way out of
  // it. A <button> is the difference between "here is the address" and
  // "here is the address, and the rest is through here".
  ok(
    "THE POINT: the customer card on a job is pressable",
    card?.tagName === "BUTTON",
    card?.tagName
  );
  ok("the card says where it goes", textOf(card).includes("View customer"), textOf(card));

  await click(card);
  const trip = TRIPS.at(-1);
  ok("THE POINT: pressing it opens the customer", trip?.to === "/customers/c1", JSON.stringify(trip));

  // THE POINT. Calendar -> job -> customer -> back -> job -> back -> calendar.
  // `from` is how the customer gets back to this job; `fromState` is how the
  // job, once you're on it again, still knows the calendar is behind it.
  ok(
    "THE POINT: the customer is told to come back to this job",
    trip?.state?.from === "/jobs/j1",
    JSON.stringify(trip?.state)
  );
  ok(
    "THE POINT: and the job's own way home travels with it",
    trip?.state?.fromState?.from === "/schedule/calendar",
    JSON.stringify(trip?.state)
  );
}

// A job booked straight off a lead: there is no customer row yet.
{
  globalThis.__job = {
    id: "j2",
    customer_id: null,
    status: "scheduled",
    starts_at: new Date(2026, 8, 23, 9, 0).toISOString(),
    duration_hours: 3,
    price: 180,
    notes: "",
    services: "Window cleaning",
    service_keys: [],
    customer: null,
    lead: { name: "Norah", address: "12 Elm St", phone: "5415550000" },
    assignments: [],
  };
  globalThis.__location = { pathname: "/jobs/j2", state: null };
  TRIPS.length = 0;

  const { host } = await mount(JobDetail);
  const card = host.querySelector(".jobDetail__lead");

  // THE POINT. A press that goes nowhere is worse than no press: it reads as
  // broken rather than as absent.
  ok(
    "THE POINT: with no customer behind it, the card is not a button",
    card?.tagName === "DIV",
    card?.tagName
  );
  ok("and it doesn't offer a door", !textOf(card).includes("View customer"), textOf(card));
  ok("the lead's details are still on it", textOf(card).includes("12 Elm St"), textOf(card));
}

/* ---- the same door on a finished job -------------------------------------- */

{
  const recordMod = await bundle("src/pages/jobs/JobRecord.jsx", "verify/.job-record-bundle.mjs");
  const JobRecord = recordMod.default;

  globalThis.__job = {
    id: "j3",
    customer_id: "c1",
    status: "completed",
    starts_at: new Date(2026, 8, 22, 9, 0).toISOString(),
    duration_hours: 3,
    price: 180,
    final_price: 180,
    paid: true,
    payment_method: "cash",
    service_plan: "one_time",
    services: "Window cleaning",
    customer: { id: "c1", name: "Susan", address: "2100 NW Harrison Blvd" },
    lead: null,
    assignments: [],
  };
  globalThis.__location = { pathname: "/jobs/record/j3", state: { from: "/schedule/calendar" } };
  TRIPS.length = 0;

  const { host } = await mount(JobRecord);

  // The record's name is an <h1>, and a <button> may not contain one — so
  // here the door is a link beside the name rather than the name itself.
  // The heading is worth more than the convenience of pressing it.
  const go = host.querySelector(".jobrec__whogo");
  ok("THE POINT: a finished job also opens its customer", !!go, textOf(host).slice(0, 160));
  ok("the heading is still a heading", !!host.querySelector("h1.jobrec__title"));

  await click(go);
  const trip = TRIPS.at(-1);
  ok("it goes to the customer", trip?.to === "/customers/c1", JSON.stringify(trip));
  ok(
    "THE POINT: carrying the record's own way home, like the job does",
    trip?.state?.from === "/jobs/record/j3" &&
      trip?.state?.fromState?.from === "/schedule/calendar",
    JSON.stringify(trip?.state)
  );
}

/* ---- the customer page, arrived at from a job ----------------------------- */

{
  globalThis.__routeId = "c1";
  globalThis.__location = {
    pathname: "/customers/c1",
    state: { from: "/jobs/j1", fromState: { from: "/schedule/calendar" } },
  };
  TRIPS.length = 0;
  const { host } = await mount(CustomerDetail);

  const back = host.querySelector(".custdetail__back");
  ok(
    "THE POINT: arriving from a job, back says job",
    textOf(back) === "← Back to job",
    textOf(back)
  );

  await click(back);
  const trip = TRIPS.at(-1);
  ok("THE POINT: and it goes to that job", trip?.to === "/jobs/j1", JSON.stringify(trip));
  ok(
    "THE POINT: handing the job back the calendar it came from",
    trip?.state?.from === "/schedule/calendar",
    JSON.stringify(trip?.state)
  );
}

/* --- report ---------------------------------------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
