import { useState, useRef, useEffect } from "react";
import "./TechPicker.css";

/**
 * techs        — array of { id, full_name, role }
 * selectedIds  — array of selected tech ids
 * onChange     — called with the new array of ids
 */
export default function TechPicker({ techs, selectedIds, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close when clicking outside the picker.
  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggle(id) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((t) => t !== id)
        : [...selectedIds, id]
    );
  }

  // Names of the currently-selected techs, for the collapsed summary.
  const selectedNames = techs
    .filter((t) => selectedIds.includes(t.id))
    .map((t) => t.full_name || "(unnamed)");

  const summary =
    selectedNames.length === 0
      ? "Assign team members"
      : selectedNames.join(", ");

  return (
    <div className="techpicker" ref={ref}>
      <button
        type="button"
        className={`techpicker__trigger ${selectedNames.length === 0 ? "techpicker__trigger--empty" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="techpicker__summary">{summary}</span>
        <span className="techpicker__arrow">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="techpicker__menu">
          {techs.length === 0 ? (
            <p className="techpicker__empty">No team members found.</p>
          ) : (
            techs.map((t) => (
              <label key={t.id} className="techpicker__option">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span className="techpicker__name">{t.full_name || "(unnamed)"}</span>
                <span className="techpicker__role">{t.role}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}