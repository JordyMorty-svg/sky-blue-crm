import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PIPELINE_STAGES,
  STALE_AFTER_DAYS,
  fetchActiveLeads,
  updateLead,
  bulkUpdateLeadStatus,
  missingFieldFor,
} from "../../services/leadService";
import LeadColumn from "../../components/LeadColumn";
import ViewSwitcher from "../../components/ViewSwitcher";
import { LEAD_VIEWS } from "../../components/navViews";
import DragPromptModal from "../../components/DragPromptModal";
import "./Leads.css";

// Load persisted collapse state (survives navigation + refresh).
function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem("leadsCollapsed")) || {};
  } catch {
    return {};
  }
}

export default function Leads() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingMove, setPendingMove] = useState(null);
  // { new: true, contacted: false, ... } — which columns are collapsed.
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // Show only leads that have sat untouched past the threshold.
  const [staleOnly, setStaleOnly] = useState(false);
  const [archiving, setArchiving] = useState(false);

  async function loadLeads() {
    try {
      const data = await fetchActiveLeads();
      setLeads(data);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load leads. Refresh to try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Started inside the effect rather than called directly, so its
    // state updates land after the await instead of synchronously
    // during the effect (react-hooks/set-state-in-effect).
    void (async () => {
      await loadLeads();
    })();
  }, []);

  // Persist collapse state whenever it changes.
  useEffect(() => {
    localStorage.setItem("leadsCollapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  function toggleCollapse(stageKey) {
    setCollapsed((cur) => ({ ...cur, [stageKey]: !cur[stageKey] }));
  }

  async function commitMove(leadId, changes, previousLeads) {
    setLeads((cur) =>
      cur.map((l) => (l.id === leadId ? { ...l, ...changes } : l))
    );
    try {
      await updateLead(leadId, changes);
    } catch (e) {
      console.error(e);
      setLeads(previousLeads);
      setError("Couldn't save that change. Try again.");
    }
  }

  function handleMove(lead, newStatus) {
    if (lead.status === newStatus) return;

    const missing = missingFieldFor(newStatus, lead);
    if (missing) {
      setPendingMove({ lead, newStatus, missing, previousLeads: leads });
    } else {
      commitMove(lead.id, { status: newStatus }, leads);
    }
  }

  function handlePromptConfirm(value, extras) {
    const { lead, newStatus, missing, previousLeads } = pendingMove;
    const changes = { status: newStatus, ...(extras || {}) };
    if (missing === "price") changes.estimate = Number(value);
    if (missing === "appointment") changes.appointment_at = value;
    commitMove(lead.id, changes, previousLeads);
    setPendingMove(null);
  }

  function handlePromptCancel() {
    setPendingMove(null);
  }

  // Sweep every stale lead into archived in one go. Deliberately a manual
  // action rather than a timed job — you stay the one deciding, and the
  // threshold can move without rewriting any data.
  async function handleArchiveStale() {
    const ids = staleLeads.map((l) => l.id);
    if (ids.length === 0) return;
    setArchiving(true);
    try {
      await bulkUpdateLeadStatus(ids, "archived");
      const gone = new Set(ids);
      setLeads((cur) => cur.filter((l) => !gone.has(l.id)));
      setStaleOnly(false);
    } catch (e) {
      console.error(e);
      setError("Couldn't archive those leads. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  if (loading) {
    return <div className="leads__state">Loading leads…</div>;
  }

  const stageLabel = (key) =>
    PIPELINE_STAGES.find((s) => s.key === key)?.label ?? key;

  const staleLeads = leads.filter((l) => l.stale);
  const shown = staleOnly ? staleLeads : leads;

  return (
    <div className="leads">
      <ViewSwitcher views={LEAD_VIEWS} section="leads" />

      {/* The switcher is the visible heading — a repeated "Pipeline" title
          directly under it was pure duplication. The h1 stays for screen
          readers and document structure, just hidden visually. */}
      <h1 className="visually-hidden">Pipeline</h1>
      <p className="leads__count">{leads.length} active</p>

      {error && <p className="leads__error">{error}</p>}

      {staleLeads.length > 0 && (
        <div className="leads__stalebar">
          <span className="leads__staletext">
            {staleLeads.length} lead{staleLeads.length === 1 ? "" : "s"} with no
            change in {STALE_AFTER_DAYS}+ days
          </span>
          <button
            className={`leads__stalebtn ${staleOnly ? "leads__stalebtn--on" : ""}`}
            onClick={() => setStaleOnly((v) => !v)}
          >
            {staleOnly ? "Show all" : "Show only these"}
          </button>
          <button
            className="leads__archivebtn"
            onClick={handleArchiveStale}
            disabled={archiving}
          >
            {archiving ? "Archiving…" : `Archive all ${staleLeads.length}`}
          </button>
        </div>
      )}

      <div className="leads__board">
        {PIPELINE_STAGES.map((stage) => (
          <LeadColumn
            key={stage.key}
            stage={stage}
            leads={shown.filter((l) => l.status === stage.key)}
            collapsed={!!collapsed[stage.key]}
            onToggle={() => toggleCollapse(stage.key)}
            onAdd={(s) => navigate(`/leads/new/${s}`)}
            onMove={handleMove}
          />
        ))}
      </div>

      {pendingMove && (
        <DragPromptModal
          field={pendingMove.missing}
          stageLabel={stageLabel(pendingMove.newStatus)}
          lead={pendingMove.lead}
          askPlan={pendingMove.newStatus === "booked"}
          onConfirm={handlePromptConfirm}
          onCancel={handlePromptCancel}
        />
      )}
    </div>
  );
}