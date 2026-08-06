import { useState } from "react";
import { createLead, TEMPERATURES } from "../services/leadService";
import "./AddLeadModal.css";

// What each stage requires. Every stage collects name/address/phone/notes;
// quoted adds price; booked adds price + appointment time.
const STAGE_LABELS = {
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
};

export default function AddLeadModal({ stage, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [estimate, setEstimate] = useState("");
  const [appointmentAt, setAppointmentAt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const needsPrice = stage === "quoted" || stage === "booked";
  const needsAppointment = stage === "booked";

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    // Validation scaled to the stage.
    if (!name.trim() || !address.trim() || !phone.trim()) {
      setError("Name, address, and phone are required.");
      return;
    }
    if (needsPrice && !estimate) {
      setError("A quoted lead needs a price.");
      return;
    }
    if (needsAppointment && !appointmentAt) {
      setError("A booked lead needs an appointment time.");
      return;
    }

    setBusy(true);
    try {
      const newLead = await createLead({
        status: stage,
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        // These columns are NOT NULL on the table, so give safe defaults.
        stories: "one",
        windows: 1,
        interior: false,
        estimate: estimate ? Number(estimate) : 0,
        appointment_at: appointmentAt || null,
        temperature: temperature || null,
        notes: notes.trim() || null,
      });
      onCreated(newLead);
    } catch (err) {
      console.error(err);
      setError("Couldn't save the lead. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">
            Add to <span className="modal__stage">{STAGE_LABELS[stage]}</span>
          </h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="modal__form" onSubmit={handleSubmit}>
          <label className="modal__label">Name</label>
          <input
            className="modal__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            autoFocus
          />

          <label className="modal__label">Address</label>
          <input
            className="modal__input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, Corvallis"
          />

          <label className="modal__label">Phone</label>
          <input
            className="modal__input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(541) 555-0123"
          />

          {needsPrice && (
            <>
              <label className="modal__label">Quoted price ($)</label>
              <input
                className="modal__input"
                type="number"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                placeholder="300"
                min="0"
              />
            </>
          )}

          {needsAppointment && (
            <>
              <label className="modal__label">Appointment</label>
              <input
                className="modal__input"
                type="datetime-local"
                value={appointmentAt}
                onChange={(e) => setAppointmentAt(e.target.value)}
              />
            </>
          )}

          {stage !== "booked" && (
            <>
              <label className="modal__label">Temperature</label>
              <select
                className="modal__input"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              >
                <option value="">— not set —</option>
                {TEMPERATURES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </>
          )}

          <label className="modal__label">Notes</label>
          <textarea
            className="modal__input modal__textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Interested, wants a callback next week…"
            rows="3"
          />

          {error && <p className="modal__error">{error}</p>}

          <div className="modal__actions">
            <button
              type="button"
              className="modal__btn modal__btn--ghost"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal__btn modal__btn--primary"
              disabled={busy}
            >
              {busy ? "Saving…" : "Add lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}