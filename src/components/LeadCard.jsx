import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  TEMPERATURES,
  LEADS_SETTABLE_STATUSES,
  serviceFor,
  telHref,
} from "../services/leadService";
import { useAuth } from "../context/useAuth";
import { can } from "./capabilities";

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
export default function LeadCard({ lead, onMove, onContact }) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const temp = TEMPERATURES.find((t) => t.key === lead.temperature);
  const phone = telHref(lead.phone);

  // A number the customer was actually given. 0 is what the CRM writes when
  // a lead is saved with the field empty, so it means "not quoted" too.
  const hasEstimate = lead.estimate != null && Number(lead.estimate) > 0;

  // Residential window washing is the house default; showing it on every
  // card would drown the one that says Gutters.
  const service =
    lead.service && lead.service !== "residential-window-washing"
      ? lead.service
      : null;

  // Stages you can move to from the board.
  //
  // Archived is never here — it's a deliberate cleanup action, not a field
  // decision. Lost used to be, for everyone, and the reason was good:
  // marking a no at the door is the single most common thing that happens
  // after a knock, and making it cost a trip to the detail page taxes the
  // motion a rep makes twenty times a day.
  //
  // It's now owners-only, and that is a real trade rather than a free win.
  // What bought it: Lost and Archived are the two transitions that can
  // release a commission, the board is shared, and the fee at stake may
  // belong to somebody else. A rep opens the lead first — where they can
  // see whose it is and when it was last touched — and everything else on
  // the card stays one tap.
  const canRetire = can(role, "retire_leads");
  const otherStages = LEADS_SETTABLE_STATUSES.filter(
    (s) =>
      s.key !== lead.status &&
      s.key !== "archived" &&
      (canRetire || s.key !== "lost")
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
          {/* The request forms (gutters, screens, pressure washing, solar)
              don't produce an estimate — only the window calculator does —
              so this used to render a lone "$" on every one of them. No
              number means we haven't quoted them yet, and that is worth
              saying out loud, because it's the next thing to do. */}
          {hasEstimate ? (
            <span className="card__estimate">${lead.estimate}</span>
          ) : (
            <span className="card__estimate card__estimate--none">
              No quote
            </span>
          )}
        </div>

        {/* Only when it isn't the obvious one. Tagging four out of five
            cards "Residential windows" is noise that makes the gutter lead
            harder to spot, not easier. */}
        {service && (
          <span className="card__service">{serviceFor(service).short}</span>
        )}

        {lead.notes && <p className="card__notes">{lead.notes}</p>}
      </div>

      {/* Outside card__body so tapping Move doesn't also open the lead. */}
      <div className="card__foot">
        <span className="card__when">
          {formatDate(lead.created_at)}
          {phone && (
            <>
              {" · "}
              {/* Dials AND records the attempt. stopPropagation because the
                  card body opens the lead — without it, ringing someone
                  would also navigate away from the board underneath them. */}
              <a
                className="card__phone"
                href={phone}
                onClick={(e) => {
                  e.stopPropagation();
                  onContact?.(lead);
                }}
              >
                {lead.phone}
              </a>
            </>
          )}
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
