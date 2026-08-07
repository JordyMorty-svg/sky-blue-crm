import { useState } from "react";
import LeadCard from "./LeadCard";
import { MANUAL_ADD_STAGES } from "../services/leadService";

export default function LeadColumn({ stage, leads, onAdd, onMove }) {
  const [collapsed, setCollapsed] = useState(false);
  const canAdd = MANUAL_ADD_STAGES.includes(stage.key);

  return (
    <div className="column">
      <div className="column__head">
        <button
          className="column__toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <span className="column__arrow">{collapsed ? "▸" : "▾"}</span>
          <span className="column__label">{stage.label}</span>
        </button>
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

      {!collapsed && (
        <div className="column__drop">
          {leads.length === 0 ? (
            <p className="column__empty">Nothing here.</p>
          ) : (
            leads.map((lead) => (
              <LeadCard key={lead.id} lead={lead} onMove={onMove} />
            ))
          )}
        </div>
      )}
    </div>
  );
}