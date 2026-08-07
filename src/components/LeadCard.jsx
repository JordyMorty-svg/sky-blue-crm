import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TEMPERATURES, PIPELINE_STAGES } from "../services/leadService";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LeadCard({ lead, onMove }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const storyLabel = lead.stories === "two" ? "2-story" : "1-story";
  const temp = TEMPERATURES.find((t) => t.key === lead.temperature);

  // Stages you can move to: everything except the current one and 'new'
  // ('new' is website-only — leads are never manually moved back into it).
  const otherStages = PIPELINE_STAGES.filter(
    (s) => s.key !== lead.status && s.key !== "new"
  );

  function handleMove(stageKey) {
    setMenuOpen(false);
    onMove(lead, stageKey);
  }

  return (
    <div className="card">
      <div
        className="card__body"
        onClick={() => navigate(`/leads/${lead.id}`)}
        role="button"
        tabIndex={0}
      >
        <div className="card__top">
          <span className="card__name">
            {temp && (
              <span
                className="card__temp"
                style={{ background: temp.color }}
                title={temp.label}
              />
            )}
            {lead.name}
          </span>
          <span className="card__estimate">${lead.estimate}</span>
        </div>

        <div className="card__meta">
          {storyLabel} · {lead.windows} windows
          {lead.interior ? " · interior" : ""}
        </div>

        <div className="card__contact">
          {lead.phone && <span>{lead.phone}</span>}
          {lead.email && <span>{lead.email}</span>}
        </div>

        {lead.notes && <p className="card__notes">{lead.notes}</p>}

        <div className="card__foot">{formatDate(lead.created_at)}</div>
      </div>

      <div className="card__actions">
        <button
          className="card__move-btn"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Move ▾
        </button>
        {menuOpen && (
          <div className="card__move-menu">
            {otherStages.map((s) => (
              <button
                key={s.key}
                className="card__move-option"
                onClick={() => handleMove(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}