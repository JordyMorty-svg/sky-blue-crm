import LeadCard from "./LeadCard";

/**
 * One pipeline stage.
 *
 * The board is a flex row and each column asks for width according to what
 * it's actually holding — see .leads__board in Leads.css. A column with no
 * cards, collapsed or not, shrinks to a rail so the busy stages get the
 * screen. Four equal columns meant a board with 20 leads in one stage spent
 * three quarters of its width showing stage names.
 *
 * `quiet` is presentational only and deliberately does NOT touch the stored
 * collapse state: an empty stage narrows itself today and widens again the
 * moment a lead lands in it, without overwriting what the user chose.
 */
export default function LeadColumn({
  stage,
  leads,
  collapsed,
  onToggle,
  onMove,
  onContact,
}) {
  const quiet = !collapsed && leads.length === 0;

  return (
    <div
      className={
        "column" +
        (collapsed ? " column--collapsed" : "") +
        (quiet ? " column--quiet" : "")
      }
    >
      <div className="column__head">
        <button
          className="column__toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          {/* One glyph that rotates rather than two different characters:
              ▸ and ▾ have different widths, so swapping them nudged the
              stage name sideways on every toggle. */}
          <span
            className={
              "column__arrow" + (collapsed ? " column__arrow--collapsed" : "")
            }
            aria-hidden="true"
          >
            ▾
          </span>
          <span className="column__label">{stage.label}</span>
        </button>
        <div className="column__head-right">
          <span className="column__count">{leads.length}</span>
        </div>
      </div>

      {!collapsed && (
        <div className="column__drop">
          {leads.length === 0 ? (
            <p className="column__empty">Nothing here.</p>
          ) : (
            leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onMove={onMove}
                onContact={onContact}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
