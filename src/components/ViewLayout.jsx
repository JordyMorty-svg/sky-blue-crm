import { Outlet, useLocation } from "react-router-dom";
import ViewSwitcher from "./ViewSwitcher";

/**
 * A section's view switcher, kept still while its views change under it.
 *
 * WHAT THIS FIXES. Every page used to render its own <ViewSwitcher>, so
 * switching views unmounted the strip and built a new one — the pill
 * blinked, the whole thing re-rendered, and on Income it visibly reloaded.
 * The switcher is the one part of the screen that must NOT move when you
 * press it: it is the thing you just aimed at.
 *
 * As a layout route the strip mounts once and React Router swaps only what
 * is inside <Outlet />. Same change, and same reasoning, as CustomerLayout
 * and LeadLayout — this is the version for sections whose views are whole
 * pages rather than tabs of one record.
 *
 * PATHLESS, on purpose. A section's views do not always share a URL prefix
 * (/income and /income/commission do; /leads and /leads/all do; a future
 * pair might not), and a layout route with no `path` of its own can wrap
 * any set of children whatever their paths. It contributes nothing to
 * matching — the children's own paths still decide everything.
 *
 * THE FADE comes from .recordpanel, shared with the record tabs so the two
 * kinds of tab in this app feel like one thing. It is keyed on the
 * pathname because React reuses the DOM when only the Outlet's child
 * changes: without the key the animation plays on first mount and never
 * again.
 */
export default function ViewLayout({ views, section }) {
  const { pathname } = useLocation();

  return (
    <>
      <ViewSwitcher views={views} section={section} />
      <div className="recordpanel" key={pathname}>
        <Outlet />
      </div>
    </>
  );
}
