import { Routes, Route, Navigate, NavLink } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/login/Login";
import Leads from "./pages/leads/Leads";
import LeadDetail from "./pages/leads/LeadDetail";
import "./App.css";

// Top navigation shell shown on every logged-in page.
function Shell({ children }) {
  const { user, profile, role, signOut } = useAuth();

  const tabs = [
    { to: "/leads", label: "Leads" },
    { to: "/jobs", label: "Jobs" },
    { to: "/income", label: "Income" },
    { to: "/map", label: "Map" },
    { to: "/won", label: "Won" },
  ];

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className="shell__brand">
          Sky Blue <span className="shell__brand-accent">CRM</span>
        </div>

        <nav className="shell__nav">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `shell__tab ${isActive ? "shell__tab--active" : ""}`
              }
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

function ComingSoon({ title }) {
  return (
    <div className="coming-soon">
      <h2>{title}</h2>
      <p>Coming soon.</p>
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
      <Route path="/leads/:id" element={<Page><LeadDetail /></Page>} />
      <Route path="/jobs" element={<Page><ComingSoon title="Jobs" /></Page>} />
      <Route path="/income" element={<Page><ComingSoon title="Income" /></Page>} />
      <Route path="/map" element={<Page><ComingSoon title="Map" /></Page>} />
      <Route path="/won" element={<Page><ComingSoon title="Won leads" /></Page>} />

      <Route path="*" element={<Navigate to="/leads" replace />} />
    </Routes>
  );
}