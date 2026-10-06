import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./LeadTabs.css";

/**
 * The two doors off a lead: Quotes and Communication.
 *
 * WHY THE LEAD PAGE SPLIT UP. It had grown into one scroll holding the edit
 * form, the quotes panel, the whole text thread and the status history —
 * four things with nothing to do with each other, stacked. The form is where
 * you fix a typo in an address; the thread is where you answer somebody.
 * Having to scroll past one to reach the other made both worse, and on a
 * phone in a driveway it made the thread practically unreachable.
 *
 * REAL ROUTES, not tabs that swap a panel. /leads/:id/quotes and
 * /leads/:id/communication are their own URLs, so the back button works, a
 * conversation can be bookmarked, and "open the texts for this lead" is a
 * link somebody can be sent. A tab strip that re-renders in place would look
 * the same and do none of that.
 *
 * Rendered on all three pages, including the ones it links to, so you can go
 * Quotes → Communication without bouncing through the form in between.
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
 * save is the same bug one step quieter. The sub-pages have no form and pass
 * nothing, in which case the buttons just navigate.
 */
export default function LeadTabs({ active = null, beforeLeave = null }) {
  const { id } = useParams();
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

  const tabs = [
    { key: "quotes", label: "Quotes", to: `/leads/${id}/quotes` },
    { key: "communication", label: "Communication", to: `/leads/${id}/communication` },
  ];

  return (
    <>
    <nav className="leadtabs" aria-label="Lead sections">
      {tabs.map((t) => {
        const current = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            className={"leadtabs__tab" + (current ? " leadtabs__tab--current" : "")}
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
    {error && <p className="leadtabs__error">{error}</p>}
    </>
  );
}
