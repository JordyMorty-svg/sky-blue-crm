import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TEMPERATURES, LEADS_SETTABLE_STATUSES } from "../services/leadService";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * One lead on the pipeline board.
 *
 * Deliberately shows less than it used to. What you scan a board for is who
 * it is, what it's worth, and how warm they seemed — everything else is
 * detail for once you've opened the lead. Stories and window count were on
 * every card and changed nothing about what you'd do next; the email was
 * there to be read rather than used.
 *
 * Notes stay, because they're the one field that actually changes a
 * decision at a glance ("$200 flat rate for interior"), but clamped to two
 * lines so one chatty note can't make its card three times the height of
 * its neighbours.
 */
export default function LeadCard({ lead, onMove }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

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

        {lead.notes && <p className="card__notes">{lead.notes}</p>}
      </div>

      {/* Outside card__body so tapping Move doesn't also open the lead. */}
      <div className="card__foot">
        <span className="card__when">
          {formatDate(lead.created_at)}
          {lead.phone ? ` · ${lead.phone}` : ""}
        </span>

        {lead.stale && (
          <span
            className="card__stale"
            title={`No status change in ${lead.daysSinceChange} days`}
          >
            {lead.daysSinceChange}d
          </span>
        )}

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
    </div>
  );
}
