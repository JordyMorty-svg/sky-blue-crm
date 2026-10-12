import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import { ALL_STATUSES } from "../../services/leadService";
import {
  describeEvent,
  partitionTexts,
  fetchContactTimeline,
  formatStamp,
} from "../../services/contactService";
// Shared page chrome — see the note in LeadQuotes.jsx.
import "./LeadDetail.css";
import "./LeadComms.css";

/**
 * Everything to do with talking to one lead, in one place.
 *
 * Ringing them, what we have said to each other, and the whole history of
 * both. All three used to be somewhere else: the Call button was wedged
 * beside the phone field on the edit form, the text thread was a panel
 * halfway down it, and the history was a separate page you reached through a
 * link called "See full history" that nobody pressed.
 *
 * They are one job. You open this page because you are about to talk to
 * somebody, and what you want is their number, what they last said, and
 * whether anyone has already chased them this week.
 *
 * THE CALL BUTTON RECORDS NOTHING — db/call-tracking.sql. It hands the call
 * to Quo, and Quo's call.completed webhook writes the row once it knows
 * whether anybody picked up. The timeline below is therefore a list of
 * calls that happened rather than of buttons that were pressed, which is
 * the whole reason it is worth putting on screen.
 */
export default function LeadComms() {
  const { id } = useParams();

  // THE LEAD COMES FROM THE LAYOUT — see LeadLayout.jsx.
  const { lead, reload } = useOutletContext();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  // Texts are in the thread directly above this timeline, so they start
  // folded away — see partitionTexts() in contactService.js. Not persisted:
  // the default is the useful one, and a preference remembered from three
  // weeks ago is a page that looks different for no visible reason.
  const [showTexts, setShowTexts] = useState(false);

  const load = useCallback(async () => {
    // The lead itself is the layout's job. This is the timeline, which is
    // the nice-to-have: a lead with no history, or a database that has not
    // run db/contact-history.sql, must still get the number and the text
    // box, which is what somebody came here for.
    try {
      setRows(await fetchContactTimeline({ leadId: id }));
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

  if (loading) return <div className="detail__state">Loading…</div>;
  // No "not found" branch: LeadLayout does not render this tab at all
  // unless it has the lead.


  // Split once per render, used twice below.
  const { rest, textCount } = partitionTexts(rows);
  const shownRows = showTexts ? rows : rest;

  return (
    <>
      <CallBar
        phone={lead.phone}
        lastContactedAt={lead.last_contacted_at}
        attempts={lead.contact_attempts}
      />

      <TextThread
        phone={lead.phone}
        theirName={lead.name}
        leadId={id}
        // A text writes a contact_log row and bumps last_contacted_at, both
        // of which are on screen above and below. Without the reload they
        // disagree until somebody refreshes, and nobody knows which is right.
        onSent={() => {
          // Both: the timeline is this page's, and the reach card's
          // "last contacted" counters live on the lead, which the layout
          // owns. Reloading only one leaves half the screen stale.
          void load();
          void reload();
        }}
      />

      {/* The whole timeline, folded in from what used to be its own page.

          Everything: calls Quo confirmed, texts both ways, emails, the
          status moves and the job milestones. Reading it is how you find out
          that the reason they have not replied is that the quote bounced. */}
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

        {historyError && <p className="detail__error">{historyError}</p>}

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
              const { title, meta, tone } = describeEvent(row, statusLabel, lead.name);
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
