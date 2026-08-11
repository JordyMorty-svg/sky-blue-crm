import { useState } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { updateJobTiming } from "../../services/calendarService";
import "./EventEditor.css";

// 7:00 AM through 9:00 PM in 30-minute increments.
function buildSlots() {
  const slots = [];
  for (let h = 7; h <= 21; h++) {
    for (const m of [0, 30]) {
      if (h === 21 && m === 30) break;
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      const suffix = h < 12 ? "AM" : "PM";
      slots.push({ value, label: `${hour12}:${String(m).padStart(2, "0")} ${suffix}` });
    }
  }
  return slots;
}
const TIME_SLOTS = buildSlots();

const DURATIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6];

export default function EventEditor({ event, onClose, onSaved }) {
  const startDate = new Date(event.start);
  const [date, setDate] = useState(startDate);
  const [time, setTime] = useState(
    `${String(startDate.getHours()).padStart(2, "0")}:${String(
      startDate.getMinutes()
    ).padStart(2, "0")}`
  );
  const [duration, setDuration] = useState(event.duration_hours || 3);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    if (!date || !time) {
      setError("Pick a date and time.");
      return;
    }
    setSaving(true);
    try {
      const [h, m] = time.split(":").map(Number);
      const combined = new Date(date);
      combined.setHours(h, m, 0, 0);
      await updateJobTiming(event.id, {
        starts_at: combined.toISOString(),
        duration_hours: Number(duration),
      });
      onSaved();
    } catch (e) {
      console.error(e);
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  return (
    <div
      className="eventeditor__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="eventeditor" onClick={(e) => e.stopPropagation()}>
        <div className="eventeditor__head">
          <div>
            <div className="eventeditor__title">{event.title}</div>
            <span
              className={`eventeditor__badge eventeditor__badge--${event.status}`}
            >
              {event.status === "completed" ? "Completed" : "Scheduled"}
            </span>
          </div>
          <button className="eventeditor__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {event.status === "completed" && (
          <p className="eventeditor__note">
            Changing a completed job's date moves its revenue to that day in your
            income reports.
          </p>
        )}

        <label className="eventeditor__label">Date</label>
        <DatePicker
          selected={date}
          onChange={(d) => setDate(d)}
          dateFormat="EEE, MMM d, yyyy"
          className="eventeditor__input"
          withPortal
        />

        <label className="eventeditor__label">Time</label>
        <select
          className="eventeditor__input"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        >
          {TIME_SLOTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <label className="eventeditor__label">Duration</label>
        <select
          className="eventeditor__input"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        >
          {DURATIONS.map((d) => (
            <option key={d} value={d}>{d} {d === 1 ? "hour" : "hours"}</option>
          ))}
        </select>

        {error && <p className="eventeditor__error">{error}</p>}

        <div className="eventeditor__actions">
          <button className="eventeditor__cancel" onClick={onClose}>Cancel</button>
          <button className="eventeditor__save" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}