import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchLeadById, fetchTechs, scheduleJob } from "../../services/jobService";
import AppointmentPicker, {
  combineToISO,
  splitFromISO,
} from "../../components/AppointmentPicker";
import "./ScheduleJob.css";

export default function ScheduleJob() {
  const { leadId } = useParams();
  const navigate = useNavigate();

  const [lead, setLead] = useState(null);
  const [techs, setTechs] = useState([]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  const [duration, setDuration] = useState(3);
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function load() {
    try {
      setLoading(true);
      const [leadData, techData] = await Promise.all([
        fetchLeadById(leadId),
        fetchTechs(),
      ]);
      setLead(leadData);
      setTechs(techData);
      const { date, time } = splitFromISO(leadData.appointment_at);
      setApptDate(date);
      setApptTime(time);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this lead.");
    } finally {
      setLoading(false);
    }
  }

  function toggleTech(id) {
    setSelectedTechs((cur) =>
      cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!apptDate || !apptTime) {
      setError("Set an appointment date and time.");
      return;
    }
    if (selectedTechs.length === 0) {
      setError("Assign at least one team member.");
      return;
    }

    setSaving(true);
    try {
      await scheduleJob({
        lead,
        startsAt: combineToISO(apptDate, apptTime),
        durationHours: Number(duration),
        techIds: selectedTechs,
        notes,
      });
      // Stays in the Jobs flow — no redirect to the customer profile.
      navigate("/jobs");
    } catch (e) {
      console.error(e);
      setError("Couldn't schedule the job. Try again.");
      setSaving(false);
    }
  }

  if (loading) return <div className="scheduleJob__state">Loading…</div>;
  if (!lead) return <div className="scheduleJob__state">{error || "Not found."}</div>;

  return (
    <div className="scheduleJob">
      <button className="scheduleJob__back" onClick={() => navigate("/jobs")}>
        ← Back to jobs
      </button>

      <h1 className="scheduleJob__title">Schedule job</h1>

      <div className="scheduleJob__lead">
        <strong>{lead.name}</strong>
        <span>{lead.address || "No address"}</span>
        <span>{lead.phone}</span>
        <span>${lead.estimate} · {lead.interior ? "Interior + exterior" : "Exterior"}</span>
      </div>

      {error && <p className="scheduleJob__error">{error}</p>}

      <form className="scheduleJob__form" onSubmit={handleSubmit}>
        <div className="scheduleJob__field">
          <AppointmentPicker
            date={apptDate}
            time={apptTime}
            onDateChange={setApptDate}
            onTimeChange={setApptTime}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Estimated duration (hours)</label>
          <input
            className="scheduleJob__input"
            type="number"
            step="0.5"
            min="0.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Assign team members</label>
          <div className="scheduleJob__techs">
            {techs.length === 0 ? (
              <p className="scheduleJob__empty">No team members found.</p>
            ) : (
              techs.map((t) => (
                <label key={t.id} className="scheduleJob__tech">
                  <input
                    type="checkbox"
                    checked={selectedTechs.includes(t.id)}
                    onChange={() => toggleTech(t.id)}
                  />
                  <span>{t.full_name || "(unnamed)"}</span>
                  <span className="scheduleJob__tech-role">{t.role}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Notes</label>
          <textarea
            className="scheduleJob__input scheduleJob__textarea"
            rows="3"
            placeholder="Gate code, dog in yard, access instructions…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="scheduleJob__actions">
          <button
            type="button"
            className="scheduleJob__cancel"
            onClick={() => navigate("/jobs")}
          >
            Cancel
          </button>
          <button type="submit" className="scheduleJob__submit" disabled={saving}>
            {saving ? "Scheduling…" : "Schedule job"}
          </button>
        </div>
      </form>
    </div>
  );
}