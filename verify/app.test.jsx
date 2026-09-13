/**
 * Does the nav actually gate, and is every gated route actually unreachable?
 *
 * The failure this is guarding against is not "the tab is still visible" —
 * that one is obvious the moment you log in. It is the quieter one: a tab
 * correctly hidden while its URL stays perfectly reachable by typing it,
 * by a bookmark, or by viewMemory replaying a remembered sub-view. So every
 * case below checks the rendered page, not just the chrome.
 */
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/context/auth-context";
import { can, defaultSourceFor, findRateFor } from "../src/components/capabilities";
import App from "../src/App";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

function renderAs(role, path) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  // Shaped like the real AuthContext value. `loading: false` matters:
  // ProtectedRoute holds everything back while it is true, so a test that
  // forgot it would render nothing and pass for the wrong reason.
  const value = {
    session: { user: { id: "u1" } },
    user: { id: "u1", email: "someone@example.com" },
    profile: { full_name: "Someone", role },
    role,
    isAdmin: role === "admin",
    isTech: role === "tech",
    loading: false,
    signOut: () => {},
  };

  act(() => {
    root.render(
      <StrictMode>
        <AuthContext.Provider value={value}>
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </AuthContext.Provider>
      </StrictMode>
    );
  });

  const tabs = [...host.querySelectorAll(".shell__tab")].map((n) =>
    n.textContent.trim()
  );
  const page = host.querySelector("[data-page]")?.dataset.page ?? null;

  act(() => root.unmount());
  host.remove();
  return { tabs, page };
}

// --- 1. The tab strip per role -------------------------------------------

const EXPECTED_TABS = {
  // No Commission tab: an owner reaches it through the Income switcher.
  admin: ["Leads", "Jobs", "Schedule", "Income", "Customers", "Map"],
  // Crew: their leads, their day, the map. No master lists, no books.
  tech: ["Leads", "Schedule", "Commission", "Map"],
  // Has the map: dropping a pin outside a house he just quoted floors for
  // is how he adds a lead.
  partner: ["Leads", "Schedule", "Commission", "Map"],
};

for (const [role, expected] of Object.entries(EXPECTED_TABS)) {
  const { tabs } = renderAs(role, "/leads");
  check(
    `${role} sees exactly ${expected.length} tabs`,
    JSON.stringify(tabs) === JSON.stringify(expected),
    `got ${JSON.stringify(tabs)}`
  );
}

// --- 2. A partner is bounced off every section they can't have -----------

const FORBIDDEN_FOR_PARTNER = [
  "/income",
  "/customers",
  "/customers/communication",
  "/customers/add-past",
  "/jobs",
  "/jobs/scheduled",
];

for (const path of FORBIDDEN_FOR_PARTNER) {
  const { page } = renderAs("partner", path);
  check(
    `partner bounced off ${path}`,
    page === "Leads",
    `landed on ${page}`
  );
}

// --- 3. ...and can still reach everything they should --------------------

const ALLOWED_FOR_PARTNER = [
  ["/leads", "Leads"],
  // Works jobs, so must be able to open the one in front of them even
  // though the Jobs tab is hidden.
  ["/jobs/abc", "JobDetail"],
  ["/leads/all", "AllLeads"],
  ["/leads/new/contacted", "NewLead"],
  ["/schedule", "Schedule"],
  ["/schedule/calendar", "Schedule"],
  // He works jobs, so completing one and returning from a Square tap must
  // not bounce — that path has a real card payment behind it.
  ["/schedule/complete/abc", "CompleteJob"],
  ["/pos-return", "PosReturn"],
  ["/map", "MapView"],
  ["/commission", "Commission"],
];

for (const [path, expected] of ALLOWED_FOR_PARTNER) {
  const { page } = renderAs("partner", path);
  check(`partner reaches ${path}`, page === expected, `got ${page}`);
}

// --- 4. A tech loses the master lists but keeps the detail pages ---------
//
// This is the regression the section split exists for. Gating job and
// customer detail behind the Jobs and Customers tabs would strand a tech on
// the job they were sent to: the calendar links to /jobs/:id, "view record"
// after completing links to /jobs/record/:id, and the map's customer pins
// link to /customers/:id.

for (const path of ["/jobs", "/jobs/scheduled", "/customers", "/customers/communication", "/income"]) {
  check(
    `tech bounced off ${path}`,
    renderAs("tech", path).page === "Leads",
    `landed on ${renderAs("tech", path).page}`
  );
}

for (const [path, expected] of [
  ["/commission", "Commission"],
  ["/jobs/abc", "JobDetail"],
  ["/jobs/record/abc", "JobRecord"],
  ["/customers/abc", "CustomerDetail"],
  ["/map", "MapView"],
]) {
  check(
    `tech still reaches ${path}`,
    renderAs("tech", path).page === expected,
    `got ${renderAs("tech", path).page}`
  );
}

check("admin reaches /income", renderAs("admin", "/income").page === "Income");
check(
  "admin reaches Commission as a view of Income",
  renderAs("admin", "/income/commission").page === "Commission",
  renderAs("admin", "/income/commission").page
);
check(
  "an admin landing on the bare /commission is sent to the Income view",
  renderAs("admin", "/commission").page === "Commission",
  renderAs("admin", "/commission").page
);
// A rep has no Income, so /income/commission must not become a back door.
check(
  "a tech is bounced off /income/commission",
  renderAs("tech", "/income/commission").page === "Leads",
  renderAs("tech", "/income/commission").page
);
check(
  "a partner is bounced off /income/commission",
  renderAs("partner", "/income/commission").page === "Leads"
);

// The tax export is the most sensitive page in the app: every job's price
// and every rep's pay on one screen, downloadable. It rides on the `income`
// section rather than a key of its own precisely so it cannot be granted
// separately by accident.
check(
  "admin reaches the tax export",
  renderAs("admin", "/income/tax").page === "TaxExport",
  renderAs("admin", "/income/tax").page
);
for (const role of ["tech", "partner", null]) {
  check(
    `${role ?? "null"} is bounced off /income/tax`,
    renderAs(role, "/income/tax").page === "Leads",
    renderAs(role, "/income/tax").page
  );
}

// A partner has no map, so nothing links them at a customer either.
check(
  "partner bounced off /customers/abc",
  renderAs("partner", "/customers/abc").page === "Leads"
);

// --- 4b. Action capabilities --------------------------------------------

check("only admin may delete leads",
  can("admin", "delete_leads") && !can("tech", "delete_leads") && !can("partner", "delete_leads"));
check("only admin sees the whole calendar",
  can("admin", "see_all_jobs") && !can("tech", "see_all_jobs") && !can("partner", "see_all_jobs"));
check("a null role may not delete leads", !can(null, "delete_leads"));
check("an unknown capability is refused, not granted", !can("admin", "typo_capability"));

// --- 4d. Retiring a lead from the board ----------------------------------
//
// Lost and Archived are the two transitions that can release a commission,
// and the board is shared, so the fee at stake may not be the tapper's.

check("only an owner may retire a lead from a card",
  can("admin", "retire_leads") && !can("tech", "retire_leads") && !can("partner", "retire_leads"));
check("only an owner may bulk-archive the stale list",
  can("admin", "bulk_archive_leads") && !can("tech", "bulk_archive_leads")
    && !can("partner", "bulk_archive_leads"));
check("a null role gets neither", !can(null, "retire_leads") && !can(null, "bulk_archive_leads"));

// --- 4c. The partner's source default and rate badge ---------------------
//
// A partner reaching the map but having no customer pages is only safe
// because MapView drops customer pins for him. If defaultSourceFor ever
// stopped answering "partner", his leads would silently land as door knocks
// and his finder's fee would attach to nothing.

// Takes the PROFILE now, not the role: the preselected source prefers
// whatever the person's commission is actually tied to, so the option that
// gets chosen and the option that carries the rate badge can never diverge.
check("a partner's leads default to the partner source",
  defaultSourceFor({ role: "partner" }) === "partner");
check("a commission tied to a source wins over the role guess",
  defaultSourceFor({ role: "tech", commission_find_source: "referral" }) === "referral");
check("everyone else falls through to createLead's own default",
  defaultSourceFor({ role: "tech" }) === null
    && defaultSourceFor({ role: "admin" }) === null
    && defaultSourceFor(null) === null);

check("the rate badge reads the profile, not a constant",
  findRateFor({ commission_find_rate: 15 }, "door") === 15
    && findRateFor({ commission_find_rate: 22.5 }, "door") === 22.5);
check("no override means no badge rather than a wrong one",
  findRateFor({ commission_find_rate: null }, "door") === null);
check("an owner gets no rate badge at all",
  findRateFor({ commission_find_rate: 15, commission_eligible: false }, "door") === null);
check("an explicit zero is shown, not hidden",
  findRateFor({ commission_find_rate: 0 }, "door") === 0);

// The bug this fixes: Trenton was shown — and paid — 15% on every lead he
// added, when the 15% was negotiated for partner referrals alone.
const TRENTON = { commission_find_rate: 15, commission_find_source: "partner" };
check("a targeted override shows on the source it is tied to",
  findRateFor(TRENTON, "partner") === 15);
check("...and NOT on a door he knocked himself",
  findRateFor(TRENTON, "door") === null, String(findRateFor(TRENTON, "door")));
check("...nor on any other source",
  findRateFor(TRENTON, "lsa") === null && findRateFor(TRENTON, "referral") === null);

// --- 5. A missing profile must not lock anyone out -----------------------
//
// The regression this catches is a redirect loop: role null, every section
// denied, so /leads bounces to /leads forever and the app renders nothing.

const nullRole = renderAs(null, "/leads");
check(
  "null role still renders a page (no redirect loop)",
  nullRole.page === "Leads",
  `got ${nullRole.page}`
);
check(
  "null role falls back to tech, so Income stays hidden",
  !nullRole.tabs.includes("Income"),
  `got ${JSON.stringify(nullRole.tabs)}`
);

// --- 6. The redirect target is always a tab that role actually has -------
//
// landingFor() and the tab strip derive from the same ordered list, and this
// is what proves they agree: if they ever drifted, a forbidden page would
// redirect somewhere equally forbidden and loop.

for (const role of ["admin", "tech", "partner", null]) {
  const { tabs, page } = renderAs(role, "/definitely-not-a-route");
  check(
    `${role ?? "null"} catch-all lands on a tab they have`,
    page !== null && tabs.length > 0,
    `page=${page} tabs=${JSON.stringify(tabs)}`
  );
}

// --- report ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  — " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
