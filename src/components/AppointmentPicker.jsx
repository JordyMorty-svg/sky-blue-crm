import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import "./AppointmentPicker.css";

// 7:00 AM through 9:00 PM in 30-minute increments.
function buildSlots() {
  const slots = [];
  for (let h = 7; h <= 21; h++) {
    for (const m of [0, 30]) {
      if (h === 21 && m === 30) break; // stop at 9:00 PM
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      const suffix = h < 12 ? "AM" : "PM";
      slots.push({ value, label: `${hour12}:${String(m).padStart(2, "0")} ${suffix}` });
    }
  }
  return slots;
}

const TIME_SLOTS = buildSlots();

/**
 * date  — a Date object (or null)
 * time  — a "HH:mm" string (or "")
 * Calls onDateChange(Date) and onTimeChange("HH:mm").
 */
export default function AppointmentPicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  label = "Appointment",
}) {
  // Combine for the confirmation readout.
  let confirmText = "";
  if (date && time) {
    const [h, m] = time.split(":").map(Number);
    const combined = new Date(date);
    combined.setHours(h, m, 0, 0);
    confirmText = combined.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return (
    <div className="appt">
      <label className="appt__label">{label} date</label>
      <DatePicker
        selected={date}
        onChange={onDateChange}
        dateFormat="EEE, MMM d, yyyy"
        placeholderText="Pick a date"
        minDate={new Date()}
        className="appt__input"
        calendarClassName="appt__calendar"
      />

      <label className="appt__label">{label} time</label>
      <select
        className="appt__input"
        value={time}
        onChange={(e) => onTimeChange(e.target.value)}
      >
        <option value="">Pick a time</option>
        {TIME_SLOTS.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      {confirmText && <p className="appt__confirm">Scheduled for {confirmText}</p>}
    </div>
  );
}
