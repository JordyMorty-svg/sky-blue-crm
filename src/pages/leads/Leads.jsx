import { useEffect, useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
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

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addStage, setAddStage] = useState(null);
  // Pending move that needs a required field before it can complete.
  const [pendingMove, setPendingMove] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } })
  );

  useEffect(() => {
    loadLeads();
  }, []);

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

  // Commit a status change (plus any extra fields) to the DB, optimistically.
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

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over) return;

    const leadId = active.id;
    const newStatus = over.id;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.status === newStatus) return;

    const missing = missingFieldFor(newStatus, lead);

    if (missing) {
      // Hold the move until the required field is provided.
      setPendingMove({ lead, newStatus, missing, previousLeads: leads });
    } else {
      // Nothing missing — move immediately.
      commitMove(leadId, { status: newStatus }, leads);
    }
  }

  // Called when the drag-prompt is confirmed with a value.
  function handlePromptConfirm(value) {
    const { lead, newStatus, missing, previousLeads } = pendingMove;
    const changes = { status: newStatus };
    if (missing === "price") changes.estimate = Number(value);
    if (missing === "appointment") changes.appointment_at = value;
    commitMove(lead.id, changes, previousLeads);
    setPendingMove(null);
  }

  // Cancel the prompt — the lead simply stays where it was (no change made).
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

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="leads__board">
          {PIPELINE_STAGES.map((stage) => (
            <LeadColumn
              key={stage.key}
              stage={stage}
              leads={leads.filter((l) => l.status === stage.key)}
              onAdd={setAddStage}
            />
          ))}
        </div>
      </DndContext>

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