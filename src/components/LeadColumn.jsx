import { useDroppable } from "@dnd-kit/core";
import LeadCard from "./LeadCard";
import { MANUAL_ADD_STAGES } from "../services/leadService";

export default function LeadColumn({ stage, leads, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  const canAdd = MANUAL_ADD_STAGES.includes(stage.key);

  return (
    <div className={`column ${isOver ? "column--over" : ""}`}>
      <div className="column__head">
        <span className="column__label">{stage.label}</span>
        <div className="column__head-right">
          <span className="column__count">{leads.length}</span>
          {canAdd && (
            <button
              className="column__add"
              onClick={() => onAdd(stage.key)}
              aria-label={`Add lead to ${stage.label}`}
              title={`Add lead to ${stage.label}`}
            >
              +
            </button>
          )}
        </div>
      </div>

      <div ref={setNodeRef} className="column__drop">
        {leads.length === 0 ? (
          <p className="column__empty">Nothing here.</p>
        ) : (
          leads.map((lead) => <LeadCard key={lead.id} lead={lead} />)
        )}
      </div>
    </div>
  );
}