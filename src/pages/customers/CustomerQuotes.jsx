import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import QuotesPanel from "../../components/QuotesPanel";
import RecordTabs from "../../components/RecordTabs";
import {
  fetchCustomer,
  suggestedQuoteFor,
} from "../../services/customerService";
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
  const navigate = useNavigate();
  const { state } = useLocation();

  const [customer, setCustomer] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [nextVisit, setNextVisit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Opened from the Actions menu, then owned by the panel like any other
  // open. Seeded once from navigation state rather than read on every
  // render, so closing the modal does not reopen it.
  const [open, setOpen] = useState(Boolean(state?.send));

  const load = useCallback(async () => {
    try {
      // One call, same as the customer page: it returns the customer AND
      // their jobs. The jobs are not decoration here — a quote closed as
      // "the work was done on another job" names which one from this list,
      // and the suggested price is derived from them.
      const { customer: row, jobs: rows } = await fetchCustomer(id);
      setCustomer(row);
      setJobs(rows || []);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
      setLoading(false);
      return;
    }

    // Only moves the suggested price from "what they last paid" to "what the
    // plan projects". A failure here costs that refinement, not the page.
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
  if (!customer) return <div className="customers__empty">{error || "Not found."}</div>;

  const propertyType = customer.property_type || "residential";

  return (
    <div className="custdetail">
      <button className="custdetail__back" onClick={() => navigate(`/customers/${id}`)}>
        ← Back to customer
      </button>

      <div className="custdetail__namerow">
        <h1 className="custdetail__name">
          {customer.name}{" "}
          <span className={`custbadge custbadge--${propertyType} custdetail__typebadge`}>
            {propertyType === "commercial" ? "Commercial" : "Residential"}
          </span>
        </h1>
      </div>

      <RecordTabs base={`/customers/${id}`} active="quotes" />

      {error && <p className="custdetail__error">{error}</p>}

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
        onChanged={load}
      />
    </div>
  );
}
