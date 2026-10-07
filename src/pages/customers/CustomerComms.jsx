import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import RecordTabs from "../../components/RecordTabs";
import { fetchCustomer } from "../../services/customerService";
import {
  ALL_STATUSES,
} from "../../services/leadService";
import {
  describeEvent,
  fetchContactTimeline,
  formatStamp,
} from "../../services/contactService";
// Shared page chrome — see the note in CustomerQuotes.jsx.
import "./Customers.css";
// The reach card and the timeline, shared with the lead's communication page
// rather than drawn twice. These two pages are the same job seen from either
// side of the lead/customer boundary, and the one thing they must not do is
// look like different features.
import "../leads/LeadComms.css";

/**
 * Everything to do with talking to one customer, in one place.
 *
 * The customer twin of LeadComms.jsx, and deliberately the same page: the
 * same reach card, the same thread, the same timeline. A person is a lead
 * while you are chasing them and a customer once they book, and the
 * conversation does not restart when they cross that line — the timeline
 * below is stitched across both by contact_timeline(), so a call made while
 * they were still a lead is right here.
 *
 * THE CALL BUTTON RECORDS NOTHING — db/call-tracking.sql. It hands the call
 * to Quo, and Quo's call.completed webhook writes the row once it knows
 * whether anybody picked up.
 */
export default function CustomerComms() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");

  const load = useCallback(async () => {
    try {
      const { customer: row } = await fetchCustomer(id);
      setCustomer(row);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
      setLoading(false);
      return;
    }

    // The timeline is the nice-to-have. A customer with no history, or a
    // database that has not run db/contact-history.sql, must still get the
    // number and the text box — which is what somebody came here for.
    try {
      setRows(await fetchContactTimeline({ customerId: id }));
      setHistoryError("");
    } catch (e) {
      console.error(e);
      setRows([]);
      setHistoryError(
        "Couldn't load the history. If db/contact-history.sql hasn't been run yet, that's why."
      );
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

      <RecordTabs base={`/customers/${id}`} active="communication" />

      {error && <p className="custdetail__error">{error}</p>}

      {/* The number, both ways to ring it, and when anybody last tried.
          A shared component because this page and its twin on the other
          side of the lead/customer line drew the identical card twice —
          and because the desktop fallback it carries had to be added to
          both at once. See CallBar.jsx. */}
      <CallBar
        phone={customer.phone}
        lastContactedAt={customer.last_contacted_at}
        attempts={customer.contact_attempts}
      />

      <TextThread
        phone={customer.phone}
        theirName={customer.name}
        customerId={id}
        // A text writes a contact_log row and bumps last_contacted_at, both
        // of which are on screen above and below.
        onSent={load}
        // Open, unlike the panel this replaced. On the customer page it was
        // collapsed because it sat under quotes and above job history and a
        // chatty customer pushed both off the screen. Here the thread IS the
        // page, and arriving at it closed would be absurd.
        startOpen
      />

      <section className="comms__history">
        <h3 className="comms__historytitle">History</h3>

        {historyError && <p className="custdetail__error">{historyError}</p>}

        {rows.length === 0 && !historyError ? (
          <p className="comms__empty">Nothing recorded yet.</p>
        ) : (
          <ol className="comms__timeline">
            {rows.map((row, i) => {
              const { title, meta, tone } = describeEvent(row, statusLabel, customer.name);
              return (
                <li
                  className={`comms__event comms__event--${tone}`}
                  key={`${row.source}-${row.seq}-${i}`}
                >
                  <span className="comms__dot" />
                  <div className="comms__body">
                    <span className="comms__eventtitle">{title}</span>
                    {meta && <span className="comms__eventmeta">{meta}</span>}
                  </div>
                  <div className="comms__when">
                    <span>{formatStamp(row.at)}</span>
                    {row.actor && <span className="comms__actor">{row.actor}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}
