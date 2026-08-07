import { useEffect, useState } from "react";
import {
  PIPELINE_STAGES,
  fetchActiveLeads,
  updateLead,
  missingFieldFor,
} from "../../services/leadService";
import LeadColumn from "../../components/LeadColumn";
import AddLeadModal from "../../components/AddLeadModal";
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
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addStage, setAddStage] = useState(null);
  const [pendingMove, setPendingMove] = useState(null);
  // { new: true, contacted: false, ... } — which columns are collapsed.
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    loadLeads();
  }, []);

  // Persist collapse state whenever it changes.
  useEffect(() => {
    localStorage.setItem("leadsCollapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  async function loadLeads() {
    try {
      setLoading(true);
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

  function handlePromptConfirm(value) {
    const { lead, newStatus, missing, previousLeads } = pendingMove;
    const changes = { status: newStatus };
    if (missing === "price") changes.estimate = Number(value);
    if (missing === "appointment") changes.appointment_at = value;
    commitMove(lead.id, changes, previousLeads);
    setPendingMove(null);
  }

  function handlePromptCancel() {
    setPendingMove(null);
  }

  function handleCreated(newLead) {
    setLeads((cur) => [newLead, ...cur]);
    setAddStage(null);
  }

  if (loading) {
    return <div className="leads__state">Loading leads…</div>;
  }

  const stageLabel = (key) =>
    PIPELINE_STAGES.find((s) => s.key === key)?.label ?? key;

  return (
    <div className="leads">
      <div className="leads__head">
        <h1 className="leads__title">Pipeline</h1>
        <span className="leads__count">{leads.length} active</span>
      </div>

      {error && <p className="leads__error">{error}</p>}

      <div className="leads__board">
        {PIPELINE_STAGES.map((stage) => (
          <LeadColumn
            key={stage.key}
            stage={stage}
            leads={leads.filter((l) => l.status === stage.key)}
            collapsed={!!collapsed[stage.key]}
            onToggle={() => toggleCollapse(stage.key)}
            onAdd={setAddStage}
            onMove={handleMove}
          />
        ))}
      </div>

      {addStage && (
        <AddLeadModal
          stage={addStage}
          onClose={() => setAddStage(null)}
          onCreated={handleCreated}
        />
      )}

      {pendingMove && (
        <DragPromptModal
          field={pendingMove.missing}
          stageLabel={stageLabel(pendingMove.newStatus)}
          onConfirm={handlePromptConfirm}
          onCancel={handlePromptCancel}
        />
      )}
    </div>
  );
}