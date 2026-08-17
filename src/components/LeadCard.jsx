import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TEMPERATURES, LEADS_SETTABLE_STATUSES } from "../services/leadService";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LeadCard({ lead, onMove }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const storyLabel = lead.stories === "two" ? "2-story" : "1-story";
  const temp = TEMPERATURES.find((t) => t.key === lead.temperature);

  // Stages you can move to from the board: forward pipeline moves, plus
  // Lost — marking a no at the door is the single most common action after
  // a knock, so it shouldn't need a trip to the detail page. Archived stays
  // excluded; it's a deliberate cleanup action, not a field decision.
  const otherStages = LEADS_SETTABLE_STATUSES.filter(
    (s) => s.key !== lead.status && s.key !== "archived"
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

        <div className="card__foot">
          <span>{formatDate(lead.created_at)}</span>
          {lead.stale && (
            <span
              className="card__stale"
              title={`No status change in ${lead.daysSinceChange} days`}
            >
              Stale · {lead.daysSinceChange}d
            </span>
          )}
        </div>
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