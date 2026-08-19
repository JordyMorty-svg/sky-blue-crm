import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/useAuth";

// Wrap any page that should require a login. If nobody's signed in,
// it bounces to /login instead of rendering the page.
export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  // While we're still checking for a session, don't flash anything.
  if (loading) {
    return <div className="crm-loading">Loading…</div>;
  }

  if (!session) {
    // Carry where they were trying to go, so signing in resumes it instead
    // of dumping them on the leads board.
    //
    // This is more than a convenience. The Square tap hand-off returns to
    // /pos-return with the transaction id in the query string, and from an
    // iOS home-screen install that return lands in Safari — a separate
    // session — so it hits this redirect every time. Throwing the URL away
    // here means throwing away the only record of a card that has already
    // been charged.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}
