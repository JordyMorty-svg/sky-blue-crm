import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import {
  ALL_STATUSES,
} from "../../services/leadService";
import {
  describeEvent,
  partitionTexts,
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
import CustomerPrefs from "../../components/CustomerPrefs";

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
  // THE CUSTOMER COMES FROM THE LAYOUT, not from a fetch of our own.
  // CustomerLayout holds the record and stays mounted across tabs; this
  // page used to re-fetch it on arrival, which is why the header blinked
  // every time somebody pressed a tab.
  const { customer, reload } = useOutletContext();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  // Texts are in the thread directly above this timeline, so they start
  // folded away — see partitionTexts() in contactService.js. Not persisted:
  // the default is the useful one, and a preference remembered from three
  // weeks ago is a page that looks different for no visible reason.
  const [showTexts, setShowTexts] = useState(false);

  const load = useCallback(async () => {
    // The customer itself is the layout's job. This is the timeline, which
    // is the nice-to-have: a customer with no history, or a database that
    // has not run db/contact-history.sql, must still get the number and
    // the text box, which is what somebody came here for.
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
  // No "not found" branch: CustomerLayout does not render this tab at all
  // unless it has the customer.


  // Split once per render, used twice below.
  const { rest, textCount } = partitionTexts(rows);
  const shownRows = showTexts ? rows : rest;

  return (
    <>
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

      {/* THE TWO SETTINGS, moved off the customer profile. They sat under
          the address there and were the third thing your eye landed on,
          which is a lot of attention for two things you change about twice
          a year. This is the page you are already on when "should we be
          emailing them?" occurs to you. */}
      <CustomerPrefs
        customer={customer}
        /* reload, not load: these switches live on the customer record,
           which the layout owns. Reloading only this page's timeline would
           leave the tickbox showing its old state until a full refresh. */
        onChanged={reload}
      />

      <section className="comms__history">
        <div className="comms__historyhead">
          <h3 className="comms__historytitle">History</h3>
          {/* Only offered when there is something to offer. A toggle that
              reveals nothing is a control that teaches people the page
              is broken. */}
          {textCount > 0 && (
            <button
              type="button"
              className="comms__texttoggle"
              onClick={() => setShowTexts((v) => !v)}
              aria-expanded={showTexts}
            >
              {showTexts ? "Hide" : "Show"} {textCount} text
              {textCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {historyError && <p className="custdetail__error">{historyError}</p>}

        {shownRows.length === 0 && !historyError ? (
          <p className="comms__empty">
            {/* THE CASE THAT WOULD LOOK LIKE A BUG. A lead you have only
                ever texted has a full history and an empty timeline, and
                "Nothing recorded yet" directly above a thread full of
                messages reads as data loss. */}
            {textCount > 0
              ? "Only texts so far — they're in the thread above."
              : "Nothing recorded yet."}
          </p>
        ) : (
          <ol className="comms__timeline">
            {shownRows.map((row, i) => {
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
    </>
  );
}

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}
