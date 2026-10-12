import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import {
  ALL_STATUSES,
} from "../../services/leadService";
import {
  describeEvent,
  partitionTimeline,
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
  // folded away — see partitionTimeline() in contactFilters.js. Not
  // persisted: the default is the useful one, and a preference remembered
  // from three weeks ago is a page that looks different for no reason.
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

  // NO PAGE-LEVEL LOADING GATE ANY MORE. The lead/customer comes from the
  // layout and is already in hand, so the number and the text box can draw
  // immediately; only the timeline below is still arriving. Blanking the
  // whole tab while a nice-to-have loads is the flash this refactor set
  // out to remove, moved one level down.
  // No "not found" branch: CustomerLayout does not render this tab at all
  // unless it has the customer.


  // Split once per render, used three times below.
  //
  // WHAT THIS PAGE SHOWS IS WHAT WAS SAID. Status moves and job milestones
  // are stripped out entirely: this timeline and the full history page were
  // printing an identical list, and the lifecycle rows outnumbered the
  // conversation six to one on an ordinary customer. They are not lost —
  // "Full history" below goes straight to the page whose job they are.
  const { spoken, conversation, textCount, elsewhere } = partitionTimeline(rows);
  const shownRows = showTexts ? conversation : spoken;

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

      <section className="comms__history">
        <div className="comms__historyhead">
          {/* NOT "History" ANY MORE. That is the name of a whole page in
              the Actions menu, and two things with the same name showing
              different lists is how somebody ends up believing one of them
              is broken. This one is narrower and says so. */}
          <h3 className="comms__historytitle">Calls &amp; emails</h3>
          <div className="comms__historyactions">
            {/* Only offered when there is something to offer. A control
                that reveals nothing teaches people the page is broken. */}
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
            {/* WHERE THE REST WENT, said out loud. The lifecycle rows this
                page now drops are the bulk of a long-standing customer's
                timeline, and a list that quietly shrinks is one nobody
                trusts. The count is what makes this read as a pointer
                rather than an apology.

                `from` so Back comes to this tab and not the profile — see
                ContactHistory.jsx, which prefers state.from over its own
                guess. */}
            {elsewhere > 0 && (
              <Link
                className="comms__fulllink"
                to={`/history/customer/${id}`}
                state={{
                  from: `/customers/${id}/communication`,
                  person: { name: customer.name, phone: customer.phone },
                }}
              >
                Full history ({elsewhere}) →
              </Link>
            )}
          </div>
        </div>

        {historyError && <p className="custdetail__error">{historyError}</p>}

        {shownRows.length === 0 && !historyError ? (
          <p className="comms__empty">
            {/* THE CASE THAT WOULD LOOK LIKE A BUG. A lead you have only
                ever texted has a full history and an empty timeline, and
                "Nothing recorded yet" directly above a thread full of
                messages reads as data loss. */}
            {loading
              ? "Loading…"
              : textCount > 0
                ? "Only texts so far — they're in the thread above."
                : elsewhere > 0
                  ? // NOT "Nothing recorded yet" — there is plenty
                    // recorded, none of it a conversation. A customer
                    // added by hand and booked the same afternoon has
                    // eight timeline rows and no call, and the old
                    // wording called that an empty record.
                    "No calls or emails yet."
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
      {/* THE TWO SETTINGS, LAST.

          They were wedged between the text composer and the history, which
          put a pair of tickboxes in the middle of the thing people come to
          this page to read. They are settings — glanced at occasionally,
          changed about twice a year — so they sit under everything else,
          in the same bordered section as the rest rather than floating
          between two of them. */}
      <CustomerPrefs customer={customer} onChanged={reload} />

    </>
  );
}

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}
