import { Navigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";

// Wrap any page that should require a login. If nobody's signed in,
// it bounces to /login instead of rendering the page.
export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();

  // While we're still checking for a session, don't flash anything.
  if (loading) {
    return <div className="crm-loading">Loading…</div>;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return children;
}