import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import "./NavTabs.css";

/**
 * The section tabs, as a horizontal scroller on a phone.
 *
 * Six tabs do not fit across 390px and never will, so something has to give.
 * They wrapped to two rows for a while; that fitted everything on screen but
 * lost the thing a strip of tabs is supposed to feel like, which is one row
 * you push sideways.
 *
 * The reason the scroller looked broken the first time was not the scrolling.
 * It was that the tab falling off the right-hand edge was CUSTOMERS — the page
 * you were standing on. A strip that hides your own location, with no
 * scrollbar and no fade, is indistinguishable from a strip that has been cut
 * off. Two fixes, and they are the whole component:
 *
 *   * the active tab is scrolled into view, so where you are is always
 *     visible without touching anything
 *   * the edges fade only while there is more in that direction, so "there is
 *     more" is visible and "that's all of it" is equally visible
 *
 * Its own component rather than living in App.jsx because it is the only part
 * of the shell with behaviour, and behaviour is the part worth testing on its
 * own — see verify/nav-tabs.mjs.
 */
export default function NavTabs({ tabs, isActive }) {
  const navRef = useRef(null);
  const [edges, setEdges] = useState("none");

  const readEdges = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;

    // 1px of slack. Sub-pixel layout means scrollLeft rarely reaches exactly
    // zero or exactly the maximum, and without this the fade never turns off
    // at either end.
    const atStart = nav.scrollLeft <= 1;
    const atEnd = nav.scrollLeft >= nav.scrollWidth - nav.clientWidth - 1;

    if (nav.scrollWidth <= nav.clientWidth + 1) setEdges("none");
    else if (atStart) setEdges("right");
    else if (atEnd) setEdges("left");
    else setEdges("both");
  }, []);

  // Layout effect, not a plain one: this sets scrollLeft, and doing it after
  // paint means the strip is drawn at position zero and then jumps. On a
  // phone that reads as the page flinching every time you navigate.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector(`.${ACTIVE}`);
    if (!nav || !active) {
      readEdges();
      return;
    }

    // scrollLeft directly rather than scrollIntoView(): that method walks up
    // and scrolls every scrollable ancestor, including the page itself, so
    // arriving on a section would also scroll the content out from under you.
    const centred =
      active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollLeft = Math.max(0, centred);

    readEdges();
  }, [tabs, readEdges]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    nav.addEventListener("scroll", readEdges, { passive: true });
    // Rotating the phone changes what fits, so the fades have to be
    // recalculated — the strip may stop needing to scroll at all.
    window.addEventListener("resize", readEdges);
    return () => {
      nav.removeEventListener("scroll", readEdges);
      window.removeEventListener("resize", readEdges);
    };
  }, [readEdges]);

  return (
    <div className="shell__navwrap" data-edges={edges}>
      <nav className="shell__nav" ref={navRef}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.root}
            to={tab.to}
            className={`shell__tab ${isActive(tab.root) ? ACTIVE : ""}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

// Named once. The effect above finds the active tab by this class, so a
// rename in the JSX that missed the query would silently stop the strip
// scrolling to where you are — and nothing would look wrong until the tab you
// were on happened to be off screen.
const ACTIVE = "shell__tab--active";
