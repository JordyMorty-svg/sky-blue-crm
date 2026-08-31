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
        {/* The arrow is its own button. Joining it to the stage name made
            the label look pressable and the arrow look decorative — the
            wrong way round — and the combined width pushed the count out of
            a collapsed rail. */}
        <button
          className="column__arrowbtn"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${stage.label}`}
        >
          {/* An inline SVG chevron rather than a text character. ▾ and ▸
              are glyphs: their size and weight depend on whichever font the
              stack resolves to, which is the same thing that made the
              column labels clip on Windows. This draws the same on every
              machine, and it scales to whatever size the button is.

              One icon that rotates, not two pointing different ways, so
              nothing beside it shifts when you toggle. */}
          <svg
            className={
              "column__arrow" + (collapsed ? " column__arrow--collapsed" : "")
            }
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M5 9l7 7 7-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <span className="column__label">{stage.label}</span>
        <span className="column__count">{leads.length}</span>
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
