import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import QuotesPanel from "../../components/QuotesPanel";
import RecordTabs from "../../components/RecordTabs";
import {
  fetchLead,
  serviceFor,
  sourceFor,
} from "../../services/leadService";
// The page chrome — .detail, .detail__top, .detail__back, .detail__title,
// .detail__tags — is shared with the lead page on purpose. These are the
// same lead seen three ways, and three stylesheets drawing the same header
// is how the back button ends up in a different place on each of them.
import "./LeadDetail.css";

/**
 * Quotes for one lead, on their own page.
 *
 * Lifted off the lead page as part of splitting it up — see RecordTabs.jsx.
 * Sending a quote is a job you sit down to do; it does not belong halfway
 * down a form you opened to fix a phone number.
 *
 * NO beforeSend HERE, and that is a real difference from the lead page.
 * There, the panel had to save the edit form before opening the modal,
 * because "Save changes" also navigated away and people lost what they had
 * typed. This page has no form to lose, so the hook is not needed and
 * passing one would be a lie about what the button does.
 */
export default function LeadQuotes() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setLead(await fetchLead(id));
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this lead.");
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

      <RecordTabs base={`/leads/${id}`} active="quotes" />

      {error && <p className="detail__error">{error}</p>}

      <QuotesPanel
        leadId={id}
        customerName={lead.name}
        customerEmail={lead.email}
        customerPhone={lead.phone}
        address={lead.address}
        // The saved estimate, not a form value — there is no form on this
        // page. It is only the modal's starting number and can be changed
        // there.
        suggestedAmount={Number(lead.estimate) || null}
        suggestedServices={lead.service ? [lead.service] : null}
        // A lead moves to Booked the moment a quote is accepted, and that
        // happens in the database. Reload so this page agrees with it.
        onChanged={load}
      />
    </div>
  );
}
