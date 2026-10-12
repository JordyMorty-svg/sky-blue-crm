import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import { ALL_STATUSES } from "../../services/leadService";
import {
  describeEvent,
  partitionTimeline,
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
  // folded away — see partitionTimeline() in contactFilters.js. Not
  // persisted: the default is the useful one, and a preference remembered
  // from three weeks ago is a page that looks different for no reason.
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

  // NO PAGE-LEVEL LOADING GATE ANY MORE. The lead/customer comes from the
  // layout and is already in hand, so the number and the text box can draw
  // immediately; only the timeline below is still arriving. Blanking the
  // whole tab while a nice-to-have loads is the flash this refactor set
  // out to remove, moved one level down.
  // No "not found" branch: LeadLayout does not render this tab at all
  // unless it has the lead.


  // Split once per render, used three times below.
  //
  // WHAT THIS PAGE SHOWS IS WHAT WAS SAID. Status moves and job milestones
  // are stripped out entirely: this timeline and the full history page were
  // printing an identical list, and on an ordinary lead the lifecycle rows
  // outnumbered the conversation several to one. They are not lost — "Full
  // history" below goes straight to the page whose job they are.
  const { spoken, conversation, textCount, elsewhere } = partitionTimeline(rows);
  const shownRows = showTexts ? conversation : spoken;

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

      {/* WHAT WAS SAID TO THEM, and only that.

          Calls Quo confirmed, texts both ways behind the toggle, emails,
          notes, opt-outs. Reading it is how you find out that the reason
          they have not replied is that the quote bounced.

          The status moves and job milestones that used to be mixed in here
          are on the full history page — see partitionTimeline(). */}
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
            {/* WHERE THE REST WENT, said out loud. A list that quietly
                shrinks is one nobody trusts; the count makes this read as
                a pointer rather than an apology.

                `from` so Back comes to this tab and not the lead info —
                see ContactHistory.jsx, which prefers state.from over its
                own guess. */}
            {elsewhere > 0 && (
              <Link
                className="comms__fulllink"
                to={`/history/lead/${id}`}
                state={{
                  from: `/leads/${id}/communication`,
                  person: { name: lead.name, phone: lead.phone },
                }}
              >
                Full history ({elsewhere}) →
              </Link>
            )}
          </div>
        </div>

        {historyError && <p className="detail__error">{historyError}</p>}

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
                    // recorded, none of it a conversation. A lead added
                    // by hand and moved straight to Booked has several
                    // timeline rows and no call, and the old wording
                    // called that an empty record.
                    "No calls or emails yet."
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
