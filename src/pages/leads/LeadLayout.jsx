import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import RecordTabs from "../../components/RecordTabs";
import { fetchLead, serviceFor, sourceFor } from "../../services/leadService";
import "./LeadDetail.css";

/*
 * One lead, three tabs, one header.
 *
 * The lead twin of CustomerLayout.jsx, and the same fix for the same
 * problem: Lead info, Quotes and Communication were three independent
 * pages that each drew the header and each fetched the lead, so switching
 * tabs tore the record down and built it again. The name blinked, the tags
 * re-flowed, and the source chip even said different things on different
 * tabs — the lead page showed "Google Ads (LSA) · Jordan" because it had
 * the creator joined in, and the other two showed "Google Ads (LSA)"
 * because they did not.
 *
 * One fetch, one header, and the tabs swap only what is below them.
 *
 * ---------------------------------------------------------------------------
 * beforeLeave IS THE WHOLE COMPLICATION
 * ---------------------------------------------------------------------------
 *
 * The lead page is a FORM, and leaving it does not save it. Pressing a tab
 * with an edited phone number in the box used to throw that edit away —
 * the bug RecordTabs' beforeLeave was written for. Now that the tabs live
 * up here, this layout has to be able to reach the form's save.
 *
 * A ref, written by the child in an effect with no dependency array. It is
 * always current, and writing to it never re-renders this component — a
 * save function held in state here would re-render the entire record on
 * every keystroke in the form below.
 *
 * The tabs always call through the ref. On Quotes and Communication there
 * is nothing registered, the call is a no-op, and they navigate straight
 * away, which is correct: those pages have no unsaved state.
 */
export default function LeadLayout() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const beforeLeaveRef = useRef(null);

  const active = pathname.endsWith("/quotes")
    ? "quotes"
    : pathname.endsWith("/communication")
      ? "communication"
      : "info";

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

  const propertyType = lead.property_type || "residential";

  return (
    <div className="detail">
      <div className="detail__top">
        <button className="detail__back" onClick={() => navigate("/leads")}>
          ← Back to pipeline
        </button>
        <span className="detail__source">
          {sourceFor(lead.source).label}
          {lead.creator?.full_name ? ` · ${lead.creator.full_name}` : ""}
        </span>
      </div>

      {/* NAME AND TAGS ON ONE LINE, tags to the right.

          They were stacked: a big name, then a row of two small pills under
          it, then the tab strip under that. Three rows of header before any
          content, on a page whose job is to be read in a driveway — and the
          tags are short enough that the space beside the name was simply
          empty. Side by side, the name reads first and what they want reads
          second, which is the order you need them in.

          They wrap under the name on a narrow phone; see .detail__namerow. */}
      <div className="detail__namerow">
        <h1 className="detail__title">{lead.name || "Lead"}</h1>
        <div className="detail__tags">
          {lead.service && (
            <span className="detail__service">{serviceFor(lead.service).label}</span>
          )}
          <span className={`detail__property detail__property--${propertyType}`}>
            {propertyType === "commercial" ? "Commercial" : "Residential"}
          </span>
        </div>
      </div>

      <RecordTabs
        base={`/leads/${id}`}
        active={active}
        infoLabel="Lead info"
        /* Through the ref, never a direct reference — see the note at the
           top. Only the Lead info tab registers anything. */
        beforeLeave={() => beforeLeaveRef.current?.()}
      />

      {error && <p className="detail__error">{error}</p>}

      {/* THE FADE IS KEYED ON THE PATH, which is what makes it work.
          React reuses the DOM when only the Outlet's child changes, so an
          animation without a key would play once and never again. The key
          remounts the wrapper on each tab, restarting it.

          120ms and 4px. Long enough to read as the panel arriving rather
          than snapping, short enough that nobody waiting to read a text
          thread ever notices it happened. */}
      <div className="recordpanel" key={pathname}>
        <Outlet context={{ lead, reload: load, beforeLeaveRef }} />
      </div>
    </div>
  );
}
