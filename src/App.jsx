import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "./context/useAuth";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/login/Login";
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
import Schedule from "./pages/schedule/Schedule";
import CompleteJob from "./pages/schedule/CompleteJob";
import PosReturn from "./pages/schedule/PosReturn";
import Income from "./pages/income/Income";
import Customers from "./pages/customers/Customers";
import CustomerDetail from "./pages/customers/CustomerDetail";
import AddPastJobs from "./pages/customers/AddPastJobs";
import MapView from "./pages/map/MapView";
import { REMEMBERED_SECTIONS } from "./components/navViews";
import { lastViewFor } from "./components/viewMemory";
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

  const tabs = [
    sectionTab("leads", "Leads"),
    sectionTab("jobs", "Jobs"),
    sectionTab("schedule", "Schedule"),
    { to: "/income", root: "/income", label: "Income" },
    { to: "/customers", root: "/customers", label: "Customers" },
    { to: "/map", root: "/map", label: "Map" },
  ];

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

        <nav className="shell__nav">
          {tabs.map((tab) => (
            <NavLink
              key={tab.root}
              to={tab.to}
              className={`shell__tab ${
                inSection(tab.root) ? "shell__tab--active" : ""
              }`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

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

// Small helper to wrap a page in auth + shell.
function Page({ children }) {
  return (
    <ProtectedRoute>
      <Shell>{children}</Shell>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route path="/leads" element={<Page><Leads /></Page>} />
      {/* Static segment outranks /leads/:id in React Router's matcher, so
          "all" is never mistaken for a lead id. */}
      <Route path="/leads/all" element={<Page><AllLeads /></Page>} />
      <Route path="/leads/new/:stage" element={<Page><NewLead /></Page>} />
      <Route path="/leads/:id" element={<Page><LeadDetail /></Page>} />
      <Route path="/jobs" element={<Page><Jobs /></Page>} />
      <Route path="/jobs/scheduled" element={<Page><Jobs /></Page>} />
      <Route path="/jobs/schedule/:leadId" element={<Page><ScheduleJob /></Page>} />
      <Route path="/jobs/visit/:jobId" element={<Page><ConfirmVisit /></Page>} />
      {/* Finished work is read-only, so it gets its own page rather than
          the editor. Static segment, so it outranks /jobs/:id. */}
      <Route path="/jobs/record/:id" element={<Page><JobRecord /></Page>} />
      <Route path="/jobs/:id" element={<Page><JobDetail /></Page>} />
      <Route path="/schedule" element={<Page><Schedule /></Page>} />
      <Route path="/schedule/calendar" element={<Page><Schedule /></Page>} />
      <Route path="/schedule/complete/:jobId" element={<Page><CompleteJob /></Page>} />
      {/* Where the Square app returns after a tap. Square opens this as a
          plain URL, so it has to be a real route — public/_redirects sends
          unknown paths to index.html, which is what makes that work. */}
      <Route path="/pos-return" element={<Page><PosReturn /></Page>} />
      <Route path="/income" element={<Page><Income /></Page>} />
      <Route path="/customers" element={<Page><Customers /></Page>} />
      <Route path="/customers/add-past" element={<Page><AddPastJobs /></Page>} />
      <Route path="/customers/:id/schedule" element={<Page><ScheduleForCustomer /></Page>} />
      <Route path="/customers/:id" element={<Page><CustomerDetail /></Page>} />
      <Route path="/map" element={<Page><MapView /></Page>} />

      <Route path="*" element={<Navigate to="/leads" replace />} />
    </Routes>
  );
}