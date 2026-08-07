import { useEffect, useState } from "react";
import { fetchTechs, scheduleJob } from "../../services/jobService";
import "../../components/AddLeadModal.css";
import "./ScheduleJobModal.css";

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

export default function ScheduleJobModal({ lead, onClose, onScheduled }) {
  const [techs, setTechs] = useState([]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  // Duration defaults to 3 hours, editable.
  const [duration, setDuration] = useState(3);
  const [startsAt, setStartsAt] = useState(toLocalInput(lead.appointment_at));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchTechs().then(setTechs).catch((e) => {
      console.error(e);
      setError("Couldn't load team members.");
    });
  }, []);

  function toggleTech(id) {
    setSelectedTechs((cur) =>
      cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!startsAt) {
      setError("Set an appointment date and time.");
      return;
    }
    if (selectedTechs.length === 0) {
      setError("Assign at least one team member.");
      return;
    }

    setBusy(true);
    try {
      await scheduleJob({
        lead,
        startsAt: new Date(startsAt).toISOString(),
        durationHours: Number(duration),
        techIds: selectedTechs,
      });
      onScheduled();
    } catch (err) {
      console.error(err);
      setError("Couldn't schedule the job. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Schedule job</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="schedule__lead">
          <strong>{lead.name}</strong>
          <span>{lead.address || "No address"}</span>
          <span>${lead.estimate} · {lead.interior ? "Interior + exterior" : "Exterior"}</span>
        </div>

        <form className="modal__form" onSubmit={handleSubmit}>
          <label className="modal__label">Appointment date &amp; time</label>
          <input
            className="modal__input"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />

          <label className="modal__label">Estimated duration (hours)</label>
          <input
            className="modal__input"
            type="number"
            step="0.5"
            min="0.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />

          <label className="modal__label">Assign team members</label>
          <div className="schedule__techs">
            {techs.length === 0 ? (
              <p className="schedule__empty">No team members found.</p>
            ) : (
              techs.map((t) => (
                <label key={t.id} className="schedule__tech">
                  <input
                    type="checkbox"
                    checked={selectedTechs.includes(t.id)}
                    onChange={() => toggleTech(t.id)}
                  />
                  <span>{t.full_name || "(unnamed)"}</span>
                  <span className="schedule__tech-role">{t.role}</span>
                </label>
              ))
            )}
          </div>

          {error && <p className="modal__error">{error}</p>}

          <div className="modal__actions">
            <button type="button" className="modal__btn modal__btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal__btn modal__btn--primary" disabled={busy}>
              {busy ? "Scheduling…" : "Schedule job"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}