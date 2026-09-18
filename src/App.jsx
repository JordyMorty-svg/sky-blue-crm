import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./context/useAuth";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/login/Login";
import ResetPassword from "./pages/login/ResetPassword";
import Leads from "./pages/leads/Leads";
import AllLeads from "./pages/leads/AllLeads";
import NewLead from "./pages/leads/NewLead";
import LeadDetail from "./pages/leads/LeadDetail";
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
import Income from "./pages/income/Income";
import Commission from "./pages/commission/Commission";
import TaxExport from "./pages/income/TaxExport";
import Customers from "./pages/customers/Customers";
import Communication from "./pages/customers/Communication";
import CustomerDetail from "./pages/customers/CustomerDetail";
import AddPastJobs from "./pages/customers/AddPastJobs";
import MapView from "./pages/map/MapView";
import PublicQuote from "./pages/quote/PublicQuote";
import NavTabs from "./components/NavTabs";
import { REMEMBERED_SECTIONS } from "./components/navViews";
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
      <Route path="/leads" element={<Page section="leads"><Leads /></Page>} />
      {/* Static segment outranks /leads/:id in React Router's matcher, so
          "all" is never mistaken for a lead id. */}
      <Route path="/leads/all" element={<Page section="leads"><AllLeads /></Page>} />
      <Route path="/leads/new/:stage" element={<Page section="leads"><NewLead /></Page>} />
      <Route path="/leads/:id" element={<Page section="leads"><LeadDetail /></Page>} />
      <Route path="/jobs" element={<Page section="jobs"><Jobs /></Page>} />
      <Route path="/jobs/scheduled" element={<Page section="jobs"><Jobs /></Page>} />
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
      <Route path="/schedule" element={<Page section="schedule"><Schedule /></Page>} />
      <Route path="/schedule/calendar" element={<Page section="schedule"><Schedule /></Page>} />
      <Route path="/schedule/complete/:jobId" element={<Page section="schedule"><CompleteJob /></Page>} />
      {/* Where the Square app returns after a tap. Square opens this as a
          plain URL, so it has to be a real route — public/_redirects sends
          unknown paths to index.html, which is what makes that work.
          Sections with `schedule`, not `jobs`: it is the tail of completing
          a job from the day's schedule, and gating it anywhere the person
          who just tapped a card can't reach would strand a real payment. */}
      <Route path="/pos-return" element={<Page section="schedule"><PosReturn /></Page>} />
      <Route path="/income" element={<Page section="income"><Income /></Page>} />
      {/* One page, two audiences: a rep sees their own earnings, an
          owner sees every rep. The component branches on isAdmin, and
          the database enforces it — RLS on `commissions` returns a rep
          only their own rows however the request is made. */}
      <Route path="/commission" element={<Page section="commission"><CommissionEntry /></Page>} />
      {/* Section "income", not "commission": as a view of Income it is
          gated by whatever gates Income, which keeps the switcher's two
          halves reachable by exactly the same people. */}
      <Route path="/income/commission" element={<Page section="income"><Commission /></Page>} />
      {/* Section "income" for the same reason as its sibling above: it is a
          view of the books, gated by whatever gates the books. It reads
          every job's price and every rep's pay, so it must never be
          reachable by a rep — and it isn't, because Income isn't. */}
      <Route path="/income/tax" element={<Page section="income"><TaxExport /></Page>} />
      <Route path="/customers" element={<Page section="customers"><Customers /></Page>} />
      {/* Static segment, so React Router ranks it above /customers/:id —
          same reason /customers/add-past already works. */}
      <Route path="/customers/communication" element={<Page section="customers"><Communication /></Page>} />
      <Route path="/customers/add-past" element={<Page section="customers"><AddPastJobs /></Page>} />
      <Route path="/customers/:id/schedule" element={<Page section="customers"><ScheduleForCustomer /></Page>} />
      {/* Same split as the job pages: the map's customer pins open this
          directly, so it can't be locked behind the Customers tab. */}
      <Route path="/customers/:id" element={<Page section="customer-detail"><CustomerDetail /></Page>} />
      <Route path="/map" element={<Page section="map"><MapView /></Page>} />

      {/* Everyone can see leads today, so this is safe for every role. If a
          role ever can't, RequireSection catches it on the next hop rather
          than looping — /leads redirects to that role's own landing. */}
      <Route path="*" element={<Navigate to="/leads" replace />} />
    </Routes>
    </RecoveryGate>
  );
}