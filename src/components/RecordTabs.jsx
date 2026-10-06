import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./RecordTabs.css";

/**
 * The two doors off a record: Quotes and Communication.
 *
 * ONE COMPONENT FOR LEADS AND CUSTOMERS, which is why it takes `base`
 * rather than reading an id out of the route. It was LeadTabs for about an
 * hour; the customer page needed exactly the same two buttons, and a second
 * copy differing only in a URL prefix is how the two pages start drifting
 * apart — one grows a third button, the other keeps two, and nobody
 * notices until somebody asks why Customers looks different.
 *
 * WHY THESE PAGES SPLIT UP. Both had grown into one scroll holding the
 * record, the quotes panel, the whole text thread and a history — things
 * with nothing to do with each other, stacked. The form is where you fix a
 * typo in an address; the thread is where you answer somebody. Having to
 * scroll past one to reach the other made both worse, and on a phone in a
 * driveway it made the thread practically unreachable.
 *
 * REAL ROUTES, not tabs that swap a panel. /leads/:id/quotes and
 * /leads/:id/communication are their own URLs, so the back button works, a
 * conversation can be bookmarked, and "open the texts for this lead" is a
 * link somebody can be sent. A tab strip that re-renders in place would look
 * the same and do none of that.
 *
 * Rendered on all three pages of a record, including the ones it links to,
 * so you can go Quotes → Communication without bouncing through the middle.
 *
 * `beforeLeave` IS THE INTERESTING PROP, and it exists because splitting the
 * page brought an old bug back.
 *
 * The lead page is a form. Leaving it does not save it — "Save changes" is a
 * button you press. So typing a new phone number and then pressing
 * Communication used to throw the edit away, silently, which is exactly the
 * bug QuotesPanel's beforeSend was written for: Hayden typed changes,
 * pressed Send a quote, and lost everything when the page navigated.
 *
 * Same answer as that one, and deliberately the same shape. The lead page
 * passes its save; it runs before we go anywhere; and if it THROWS we stay
 * put and say so, because navigating off a page whose edits just failed to
 * save is the same bug one step quieter. Pages with no unsaved state — the
 * sub-pages, and the customer page, whose edit form is a modal that saves
 * itself — pass nothing, and the buttons just navigate.
 */
export default function RecordTabs({ base, active = null, beforeLeave = null }) {
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");

  async function go(to, current) {
    // The current page's own button does nothing rather than navigating to
    // where you already are — which would push a duplicate history entry
    // and make Back feel broken.
    if (current || leaving) return;

    if (!beforeLeave) {
      navigate(to);
      return;
    }

    setLeaving(true);
    setError("");
    try {
      await beforeLeave();
      navigate(to);
    } catch (e) {
      console.error("Couldn't save before leaving the lead:", e);
      setError(
        e?.message ||
          "Couldn't save your changes, so you're still here. Fix that first."
      );
    } finally {
      setLeaving(false);
    }
  }

  // `base` is the record's own page — "/leads/abc" or "/customers/abc" —
  // and the sub-pages hang off it. Trailing slash stripped so a caller
  // passing one does not produce "/customers/abc//quotes", which React
  // Router matches as a different path and renders as nothing.
  const root = String(base || "").replace(/\/+$/, "");
  const tabs = [
    { key: "quotes", label: "Quotes", to: `${root}/quotes` },
    { key: "communication", label: "Communication", to: `${root}/communication` },
  ];

  return (
    <>
    <nav className="rectabs" aria-label="Lead sections">
      {tabs.map((t) => {
        const current = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            className={"rectabs__tab" + (current ? " rectabs__tab--current" : "")}
            // aria-current, not aria-selected: these are links to other
            // pages, not tabs in a tablist. A screen reader should say "you
            // are here", not "tab 1 of 2 selected".
            aria-current={current ? "page" : undefined}
            disabled={leaving}
            onClick={() => void go(t.to, current)}
          >
            {leaving && !current ? "Saving…" : t.label}
          </button>
        );
      })}
    </nav>
    {error && <p className="rectabs__error">{error}</p>}
    </>
  );
}
