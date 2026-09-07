import { SERVICE_TYPES, serviceSentence } from "../services/leadService";
import "./ServicePicker.css";

/**
 * What this visit covers. One or more.
 *
 * A job holds several services because that's how the work actually goes:
 * you're booked for windows, you're already there, and they ask about the
 * gutters. Forcing that into one "primary service" would either lose the
 * gutters or need a second job for the same visit.
 *
 * Toggles rather than a multi-select listbox — a native multi-select needs
 * ctrl-click to add a second option, which nobody discovers, and is
 * genuinely awful on the phone this gets used on.
 */
export default function ServicePicker({
  value = [],
  onChange,
  label = "Services",
  hint = "everything this visit covers",
  disabled = false,
}) {
  const selected = new Set(value || []);

  function toggle(key) {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    // Emitted in SERVICE_TYPES order rather than click order, so the same
    // set of services always reads the same way — otherwise the job
    // description would depend on which chip someone happened to tap first.
    onChange(SERVICE_TYPES.filter((s) => next.has(s.key)).map((s) => s.key));
  }

  return (
    <div className="svcpick">
      <div className="svcpick__head">
        <span className="svcpick__label">{label}</span>
        {hint && <span className="svcpick__hint">{hint}</span>}
      </div>

      <div className="svcpick__options" role="group" aria-label={label}>
        {SERVICE_TYPES.map((s) => {
          const on = selected.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              className={"svcpick__chip" + (on ? " svcpick__chip--on" : "")}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(s.key)}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Reads back the sentence that will end up on the job and in the
          customer's follow-up email. Worth showing: "Gutter cleaning and
          residential windows" is the thing being written, and it's easier
          to notice a wrong chip here than on the schedule next week. */}
      {selected.size > 0 ? (
        <p className="svcpick__preview">{serviceSentence(value)}</p>
      ) : (
        <p className="svcpick__preview svcpick__preview--empty">
          Nothing picked — the job won't say what it's for.
        </p>
      )}
    </div>
  );
}
