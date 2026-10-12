import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./context/useAuth";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/login/Login";
import ResetPassword from "./pages/login/ResetPassword";
import Leads from "./pages/leads/Leads";
import AllLeads from "./pages/leads/AllLeads";
import NewLead from "./pages/leads/NewLead";
import LeadLayout from "./pages/leads/LeadLayout";
import LeadDetail from "./pages/leads/LeadDetail";
import LeadQuotes from "./pages/leads/LeadQuotes";
import LeadComms from "./pages/leads/LeadComms";
import Jobs from "./pages/jobs/Jobs";
import ScheduleJob from "./pages/jobs/ScheduleJob";
import ConfirmVisit from "./pages/jobs/ConfirmVisit";
import ScheduleForCustomer from "./pages/customers/ScheduleForCustomer";
import JobDetail from "./pages/jobs/JobDetail";
import JobRecord from "./pages/jobs/JobRecord";
import ContactHistory from "./pages/history/ContactHistory";
import Schedule from "./pages/schedule/Schedule";
import CompleteJob from "./pages/schedule/CompleteJob";
import PosReturn from "./pages/schedule/PosReturn";
import ViewLayout from "./components/ViewLayout";
import Income from "./pages/income/Income";
import Commission from "./pages/commission/Commission";
import TaxExport from "./pages/income/TaxExport";
import Customers from "./pages/customers/Customers";
import Communication from "./pages/customers/Communication";
import Undelivered from "./pages/customers/Undelivered";
import CustomerLayout from "./pages/customers/CustomerLayout";
import CustomerDetail from "./pages/customers/CustomerDetail";
import CustomerQuotes from "./pages/customers/CustomerQuotes";
import CustomerComms from "./pages/customers/CustomerComms";
import AddPastJobs from "./pages/customers/AddPastJobs";
import MapView from "./pages/map/MapView";
import PublicQuote from "./pages/quote/PublicQuote";
import NavTabs from "./components/NavTabs";
import {
  CUSTOMER_VIEWS,
  INCOME_VIEWS,
  JOB_VIEWS,
  LEAD_VIEWS,
  REMEMBERED_SECTIONS,
  SCHEDULE_VIEWS,
} from "./components/navViews";
import { lastViewFor } from "./components/viewMemory";
import { canSee, landingFor, navSectionsFor } from "./components/capabilities";
import "./App.css";

// Top navigation shell shown on every logged-in page.
function Shell({ children }) {
  const { user, profile, role, signOut } = useAuth();
  // Re-read on every navigation so the remembered destinations stay current.
  const { pathname } = useLocation();

  // Five sections. Views within a section (Pipeline/Map, Customers/All
  // leads) live on a switcher inside the page rather than up here.
  // Sections with multiple views return you to the one you last used.
  // `root` is what decides highlighting, since `to` may point at a
  // sub-view like /leads/all.
  function sectionTab(key, label) {
    const { root, views } = REMEMBERED_SECTIONS[key];
    return {
      root,
      label,
      to: lastViewFor(
        key,
        root,
        views.map((v) => v.to)
      ),
    };
  }

  // Defined once per section, then ordered and filtered by the capability
  // map. Driving the order from navSectionsFor rather than from this object
  // is what keeps the tab strip and landingFor() agreeing about which tab
  // comes first — the redirect target for a forbidden page is that first
  // tab, so the two disagreeing would send people somewhere they can't use.
  const TAB_DEFS = {
    leads: () => sectionTab("leads", "Leads"),
    jobs: () => sectionTab("jobs", "Jobs"),
    schedule: () => sectionTab("schedule", "Schedule"),
    // sectionTab, not a fixed "/income": Income has two views now, and a
    // hardcoded target means tapping the nav always dumps you back on the
    // books even when you were last looking at Commission. Same treatment
    // every other multi-view section already gets.
    income: () => sectionTab("income", "Income"),
    commission: () => ({
      to: "/commission",
      root: "/commission",
      label: "Commission",
    }),
    customers: () => sectionTab("customers", "Customers"),
    map: () => ({ to: "/map", root: "/map", label: "Map" }),
  };

  const tabs = navSectionsFor(role).map((key) => ({ key, ...TAB_DEFS[key]() }));

  // NavLink's own isActive compares against `to`, which breaks once `to`
  // is a remembered sub-view. Highlight on the section root instead.
  const inSection = (root) =>
    pathname === root || pathname.startsWith(root + "/");

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className="shell__brand">
          Sky Blue <span className="shell__brand-accent">CRM</span>
        </div>

        {/* The strip owns its own scrolling — see NavTabs.jsx. `tabs` is
            rebuilt on every navigation because `to` is a remembered sub-view,
            which is also what re-runs the scroll-to-active effect inside it. */}
        <NavTabs tabs={tabs} isActive={inSection} />

        <div className="shell__user">
          <span className="shell__email">
            {profile?.full_name || user?.email}
            {role && <span className="shell__role">{role}</span>}
          </span>
          <button className="shell__signout" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="shell__main">{children}</main>
    </div>
  );
}

// Commission lives in two places, and this decides which one you get.
//
// An owner reaches it as a view of Income; a rep reaches it as a tab. Anyone
// arriving at the bare /commission — a bookmark, a remembered view, a typed
// URL, a link from an older build — is sent to whichever is canonical for
// them rather than shown a page with no way back to its sibling.
function CommissionEntry() {
  const { isAdmin } = useAuth();
  if (isAdmin) return <Navigate to="/income/commission" replace />;
  return <Commission />;
}

// Bounce a role that can't have this section to somewhere it can.
//
// Hiding the tab is not enough on its own: the URL is typed, bookmarked,
// remembered by viewMemory, and linked to from inside other pages. Without
// this, /income stays perfectly reachable for a partner who has ever seen
// the address once.
//
// `replace` so the page they couldn't have doesn't sit in history waiting
// for the back button to bounce them again.
function RequireSection({ section, children }) {
  const { role } = useAuth();

  if (section && !canSee(role, section)) {
    return <Navigate to={landingFor(role)} replace />;
  }

  return children;
}

// Small helper to wrap a page in auth + section check + shell.
//
// The order is load-bearing. ProtectedRoute is outermost because it holds
// the render back until the session and profile have resolved — checking the
// section first would read a null role mid-load and redirect a perfectly
// entitled admin away from Income on every cold start.
function Page({ children, section }) {
  return (
    <ProtectedRoute>
      <RequireSection section={section}>
        <Shell>{children}</Shell>
      </RequireSection>
    </ProtectedRoute>
  );
}

// A password-reset link that lands anywhere else gets sent here.
//
// Supabase's dashboard "send recovery" button doesn't attach a redirect, so
// the mail falls back to the project's Site URL — the site root — and the
// catch-all route below forwards that to the leads board. The person ends
// up signed in, on the wrong page, still using the password they were
// trying to change.
//
// Catching it on the session rather than on the URL means it works however
// the link was sent: from the app's own Forgot link, from the dashboard, or
// from anything added later.
function RecoveryGate({ children }) {
  const { recovery } = useAuth();
  const { pathname } = useLocation();

  if (recovery && pathname !== "/reset-password") {
    return <Navigate to="/reset-password" replace />;
  }
  return children;
}

export default function App() {
  return (
    <RecoveryGate>
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public, and not wrapped in Page. A recovery link does create a
          session, so ProtectedRoute would let it through — but an expired
          or already-used one would not, and bouncing someone to a sign-in
          form they cannot get past is the least useful answer to "my reset
          link didn't work". The page explains it instead. */}
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* The customer's quote. The one route in this app that a stranger is
          meant to reach, so it sits outside Page entirely — no
          ProtectedRoute, no RequireSection, no Shell. Wrapping it would put
          a sign-in form in front of the person we are trying to sell to.

          It touches Supabase only through /api/quote/:token, which uses the
          service key server-side; the anon key never reaches this page, and
          `quotes` stays staff-only in the database.

          Short path on purpose — it gets pasted into a text message, where
          every character is visible. */}
      <Route path="/q/:token" element={<PublicQuote />} />

      {/* Every Page carries the section it belongs to, and that string is
          the same one the nav filters on — so a tab and its routes can't
          drift apart into a hidden-but-reachable page. */}
      {/* THE SWITCHER STAYS MOUNTED — see ViewLayout.jsx. These were
          siblings, so pressing a view rebuilt the strip you had just
          aimed at. */}
      <Route
        element={
          <Page section="leads">
            <ViewLayout views={LEAD_VIEWS} section="leads" />
          </Page>
        }
      >
        <Route path="/leads" element={<Leads />} />
        <Route path="/leads/all" element={<AllLeads />} />
      </Route>
      <Route path="/leads/new/:stage" element={<Page section="leads"><NewLead /></Page>} />
      {/* ONE LEAD, THREE TABS, ONE MOUNT — the same nesting as the
          customer routes above, and for the same reason. As three siblings
          each tab re-fetched the lead and redrew the header, so the name
          blinked and the source chip even disagreed between tabs: the lead
          page joined the creator in and said "Google Ads (LSA) · Jordan"
          while the other two said "Google Ads (LSA)". */}
      <Route path="/leads/:id" element={<Page section="leads"><LeadLayout /></Page>}>
        <Route index element={<LeadDetail />} />
        <Route path="quotes" element={<LeadQuotes />} />
        <Route path="communication" element={<LeadComms />} />
      </Route>
      {/* The two sub-pages off a lead. Real routes rather than tabs that
          swap a panel, so Back works and a conversation can be linked to —
          see src/components/RecordTabs.jsx.

          AFTER /leads/:id, and it does not matter here: React Router v6
          ranks by specificity rather than by order, so a two-segment path
          outranks the one-segment one however they are written. Listed in
          this order for reading, not for matching. */}
      {/* THE SWITCHER STAYS MOUNTED — see ViewLayout.jsx. These were
          siblings, so pressing a view rebuilt the strip you had just
          aimed at. */}
      <Route
        element={
          <Page section="jobs">
            <ViewLayout views={JOB_VIEWS} section="jobs" />
          </Page>
        }
      >
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/scheduled" element={<Jobs />} />
      </Route>
      <Route path="/jobs/schedule/:leadId" element={<Page section="jobs"><ScheduleJob /></Page>} />
      <Route path="/jobs/visit/:jobId" element={<Page section="jobs"><ConfirmVisit /></Page>} />
      {/* Finished work is read-only, so it gets its own page rather than
          the editor. Static segment, so it outranks /jobs/:id. */}
      {/* One page, reached as /history/lead/:id or /history/customer/:id.
          Both resolve to the same person — see contact_timeline() — so it
          sits under `leads`: it's reached by tapping a lead you can already
          see, and gating it to `customers` would dead-end that link for a
          partner on their own lead. */}
      <Route path="/history/:kind/:id" element={<Page section="leads"><ContactHistory /></Page>} />

      {/* `job-detail`, not `jobs`. The calendar and the completion screen
          both link straight here for the job you were sent to, so gating it
          with the Jobs tab would strand a tech on the job in front of them.
          Browsing every job is the tab; opening one is not. */}
      <Route path="/jobs/record/:id" element={<Page section="job-detail"><JobRecord /></Page>} />
      <Route path="/jobs/:id" element={<Page section="job-detail"><JobDetail /></Page>} />
      {/* THE SWITCHER STAYS MOUNTED — see ViewLayout.jsx. These were
          siblings, so pressing a view rebuilt the strip you had just
          aimed at. */}
      <Route
        element={
          <Page section="schedule">
            <ViewLayout views={SCHEDULE_VIEWS} section="schedule" />
          </Page>
        }
      >
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/schedule/calendar" element={<Schedule />} />
      </Route>
      <Route path="/schedule/complete/:jobId" element={<Page section="schedule"><CompleteJob /></Page>} />
      {/* Where the Square app returns after a tap. Square opens this as a
          plain URL, so it has to be a real route — public/_redirects sends
          unknown paths to index.html, which is what makes that work.
          Sections with `schedule`, not `jobs`: it is the tail of completing
          a job from the day's schedule, and gating it anywhere the person
          who just tapped a card can't reach would strand a real payment. */}
      <Route path="/pos-return" element={<Page section="schedule"><PosReturn /></Page>} />
      {/* The bare /commission, which is a rep's own tab and an owner's
          bookmark. OUTSIDE the income layout deliberately: a rep has no
          Income view to switch to, so the strip would be a three-option
          control with two options they cannot use. CommissionEntry sends
          an owner on to /income/commission, which is inside it. */}
      <Route path="/commission" element={<Page section="commission"><CommissionEntry /></Page>} />

      {/* THE SWITCHER STAYS MOUNTED — see ViewLayout.jsx. These were
          siblings, so pressing a view rebuilt the strip you had just
          aimed at. */}
      <Route
        element={
          <Page section="income">
            <ViewLayout views={INCOME_VIEWS} section="income" />
          </Page>
        }
      >
        <Route path="/income" element={<Income />} />
        <Route path="/income/commission" element={<Commission />} />
        <Route path="/income/tax" element={<TaxExport />} />
      </Route>
      {/* THE SWITCHER STAYS MOUNTED — see ViewLayout.jsx. These were
          siblings, so pressing a view rebuilt the strip you had just
          aimed at. */}
      <Route
        element={
          <Page section="customers">
            <ViewLayout views={CUSTOMER_VIEWS} section="customers" />
          </Page>
        }
      >
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/communication" element={<Communication />} />
        <Route path="/customers/undelivered" element={<Undelivered />} />
      </Route>
      <Route path="/customers/add-past" element={<Page section="customers"><AddPastJobs /></Page>} />
      <Route path="/customers/:id/schedule" element={<Page section="customers"><ScheduleForCustomer /></Page>} />
      {/* ONE CUSTOMER, THREE TABS, ONE MOUNT.

          These were three sibling routes, so switching tabs unmounted the
          whole record and built it again — the header blinked, the badges
          re-flowed, and each page fetched the same customer for itself.
          Nested under CustomerLayout they share a parent that stays
          mounted: React Router swaps only what is inside its <Outlet />,
          so pressing a tab changes the part below the strip and nothing
          above it moves.

          Same split as the job pages: the map's customer pins open this
          directly, so it can't be locked behind the Customers tab.

          NOTE the near-collision with /customers/communication above,
          which is the bulk follow-up screen for everybody rather than one
          customer's thread. React Router ranks a static segment above a
          dynamic one, so that URL still reaches that page — but the two
          names are one careless rename apart from being the same URL. */}
      <Route path="/customers/:id" element={<Page section="customer-detail"><CustomerLayout /></Page>}>
        <Route index element={<CustomerDetail />} />
        <Route path="quotes" element={<CustomerQuotes />} />
        <Route path="communication" element={<CustomerComms />} />
      </Route>
      <Route path="/map" element={<Page section="map"><MapView /></Page>} />

      {/* Everyone can see leads today, so this is safe for every role. If a
          role ever can't, RequireSection catches it on the next hop rather
          than looping — /leads redirects to that role's own landing. */}
      <Route path="*" element={<Navigate to="/leads" replace />} />
    </Routes>
    </RecoveryGate>
  );
}