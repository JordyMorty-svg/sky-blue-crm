import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import TextThread from "../../components/TextThread";
import CallBar from "../../components/CallBar";
import RecordTabs from "../../components/RecordTabs";
import {
  ALL_STATUSES,
  fetchLead,
  serviceFor,
  sourceFor,
} from "../../services/leadService";
import {
  describeEvent,
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
  const navigate = useNavigate();

  const [lead, setLead] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");

  const load = useCallback(async () => {
    try {
      setLead(await fetchLead(id));
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this lead.");
      setLoading(false);
      return;
    }

    // The timeline is the nice-to-have. A lead with no history, or a
    // database that has not run db/contact-history.sql, must still get the
    // number and the text box — which is what somebody came here for.
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
  if (!lead) return <div className="detail__state">{error || "Not found."}</div>;


  return (
    <div className="detail">
      <div className="detail__top">
        <button className="detail__back" onClick={() => navigate(`/leads/${id}`)}>
          ← Back to lead
        </button>
        <span className="detail__source">{sourceFor(lead.source).label}</span>
      </div>

      <h1 className="detail__title">{lead.name || "Lead"}</h1>

      <div className="detail__tags">
        {lead.service && (
          <span className="detail__service">{serviceFor(lead.service).label}</span>
        )}
        <span
          className={`detail__property detail__property--${
            lead.property_type || "residential"
          }`}
        >
          {(lead.property_type || "residential") === "commercial"
            ? "Commercial"
            : "Residential"}
        </span>
      </div>

      <RecordTabs base={`/leads/${id}`} active="communication" />

      {error && <p className="detail__error">{error}</p>}

      {/* The number, the Call button, and when anybody last tried.

          Together, because they answer one question — "should I ring them,
          and what will they already have heard from us?" — and apart they
          answer none of it. "4 attempts" beside a Call button is the line
          that stops a fifth. */}
      {/* The number, both ways to ring it, and when anybody last tried.
          A shared component because this page and its twin on the other
          side of the lead/customer line drew the identical card twice —
          and because the desktop fallback it carries had to be added to
          both at once. See CallBar.jsx. */}
      <CallBar
        phone={lead.phone}
        lastContactedAt={lead.last_contacted_at}
        attempts={lead.contact_attempts}
      />

      <TextThread
        phone={lead.phone}
        leadId={id}
        // A text writes a contact_log row and bumps last_contacted_at, both
        // of which are on screen above and below. Without the reload they
        // disagree until somebody refreshes, and nobody knows which is right.
        onSent={load}
      />

      {/* The whole timeline, folded in from what used to be its own page.

          Everything: calls Quo confirmed, texts both ways, emails, the
          status moves and the job milestones. Reading it is how you find out
          that the reason they have not replied is that the quote bounced. */}
      <section className="comms__history">
        <h3 className="comms__historytitle">History</h3>

        {historyError && <p className="detail__error">{historyError}</p>}

        {rows.length === 0 && !historyError ? (
          <p className="comms__empty">Nothing recorded yet.</p>
        ) : (
          <ol className="comms__timeline">
            {rows.map((row, i) => {
              const { title, meta, tone } = describeEvent(row, statusLabel);
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
