import { useCallback, useEffect, useState } from "react";
import { useLocation, useOutletContext, useParams } from "react-router-dom";
import QuotesPanel from "../../components/QuotesPanel";
import { suggestedQuoteFor } from "../../services/customerService";
import { fetchNextVisit } from "../../services/jobService";
// The page chrome — .custdetail__back, .custdetail__namerow,
// .custdetail__name, .custbadge — is shared with the customer page on
// purpose. These are the same customer seen three ways, and three
// stylesheets drawing the same header is how the back button ends up in a
// different place on each of them.
import "./Customers.css";

/**
 * Quotes for one customer, on their own page.
 *
 * Lifted off the customer page the same way they were lifted off the lead
 * page — see RecordTabs.jsx.
 *
 * IT CAN OPEN ITSELF. "Send a quote" in the customer page's Actions menu
 * navigates here with `state.send`, and the panel opens straight into the
 * modal. Without that, moving quotes to their own page would have turned a
 * one-tap action into three: open the menu, land on a page, find the
 * button. The menu item did not get worse because the page moved.
 */
export default function CustomerQuotes() {
  const { id } = useParams();
  const { state } = useLocation();

  // THE CUSTOMER AND THEIR JOBS COME FROM THE LAYOUT. Both were fetched
  // again here on arrival, which is one of the three round trips that made
  // switching tabs blink.
  const { customer, jobs, reload } = useOutletContext();

  const [nextVisit, setNextVisit] = useState(null);
  const [loading, setLoading] = useState(true);
  // Opened from the Actions menu, then owned by the panel like any other
  // open. Seeded once from navigation state rather than read on every
  // render, so closing the modal does not reopen it.
  const [open, setOpen] = useState(Boolean(state?.send));

  const load = useCallback(async () => {
    // Only the projected next visit, which moves the suggested price from
    // "what they last paid" to "what the plan projects". A failure costs
    // that refinement, not the page — and the customer and their jobs are
    // the layout's job now.
    try {
      setNextVisit(await fetchNextVisit(id));
    } catch (e) {
      console.error("Couldn't load the next visit:", e);
      setNextVisit(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  if (loading) return <div className="customers__empty">Loading…</div>;
  // No "not found" branch: CustomerLayout does not render this tab at all
  // unless it has the customer.


  return (
    <>
      <QuotesPanel
        customerId={id}
        customerName={customer.name}
        customerEmail={customer.email}
        customerPhone={customer.phone}
        address={customer.address}
        // So a quote closed because the work happened elsewhere can name
        // which job.
        jobs={jobs}
        // The same number the customer page's Actions menu would have
        // suggested — one derivation, in customerService.
        suggestedAmount={suggestedQuoteFor(customer, jobs, nextVisit)}
        open={open}
        onOpenChange={setOpen}
        onChanged={() => { void load(); void reload(); }}
      />
    </>
  );
}
