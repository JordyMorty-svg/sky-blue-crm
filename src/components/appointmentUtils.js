// Date <-> ISO helpers for the appointment picker.
//
// Separated from AppointmentPicker.jsx so that file exports only its
// component — a non-component export alongside a component breaks React
// Fast Refresh (react-refresh/only-export-components).
// Helper: turn a date + "HH:mm" into an ISO string for the database.
export function combineToISO(date, time) {
  if (!date || !time) return null;
  const [h, m] = time.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// Helper: split an ISO timestamp back into a Date + "HH:mm" for editing.
export function splitFromISO(iso) {
  if (!iso) return { date: null, time: "" };
  const d = new Date(iso);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  return { date: d, time };
}