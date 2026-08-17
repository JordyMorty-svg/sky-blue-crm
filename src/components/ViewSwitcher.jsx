import { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { rememberView, matchView } from "./viewMemory";
import "./ViewSwitcher.css";

/**
 * Segmented control for switching between views of the same section.
 *
 * Views are routes rather than local state, so each one is linkable,
 * survives a refresh, and the browser back button behaves as expected.
 *
 * Pass `section` to have the last-used view remembered — the top nav then
 * returns you here instead of resetting to the section's first view.
 *
 * `counts` is an optional map of route -> number, rendered as a badge on
 * the tab. It keeps a view's volume visible while you're looking at the
 * other one, which is the main thing a switcher otherwise costs you.
 *
 * views: [{ to, label, end }]
 */
export default function ViewSwitcher({ views, section, counts }) {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!section) return;
    const active = matchView(views, pathname);
    if (active) rememberView(section, active.to);
  }, [section, views, pathname]);

  return (
    <nav className="viewswitch" aria-label="View">
      {views.map((v) => (
        <NavLink
          key={v.to}
          to={v.to}
          end={v.end}
          className={({ isActive }) =>
            `viewswitch__tab ${isActive ? "viewswitch__tab--active" : ""}`
          }
        >
          {v.label}
          {counts?.[v.to] != null && (
            <span className="viewswitch__count">{counts[v.to]}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
