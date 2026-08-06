import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "react-router-dom";
import { TEMPERATURES } from "../services/leadService";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LeadCard({ lead }) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.4 : 1,
      }
    : undefined;

  const storyLabel = lead.stories === "two" ? "2-story" : "1-story";
  const temp = TEMPERATURES.find((t) => t.key === lead.temperature);

  // Only navigate on a genuine click, not at the end of a drag.
  function handleClick() {
    if (!isDragging) navigate(`/leads/${lead.id}`);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="card"
      onClick={handleClick}
      {...listeners}
      {...attributes}
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
  );
}