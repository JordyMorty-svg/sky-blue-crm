import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchLeadById, fetchTechs, scheduleJob } from "../../services/jobService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import TechPicker from "../../components/TechPicker";
import DayPreview from "./DayPreview";
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
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
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

  useEffect(() => {
    // Started inside the effect rather than called directly, so its
    // state updates land after the await instead of synchronously
    // during the effect (react-hooks/set-state-in-effect).
    void (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

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
          <TechPicker
            techs={techs}
            selectedIds={selectedTechs}
            onChange={setSelectedTechs}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Day preview & conflicts</label>
          <DayPreview
            day={apptDate}
            time={apptTime}
            duration={Number(duration)}
            techIds={selectedTechs}
            onConflictChange={setConflicts}
          />
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

        {conflicts.length > 0 && (
          <p className="scheduleJob__conflict">
            ⚠️ This overlaps an existing job for{" "}
            {[...new Set(conflicts.map((c) => c.techName))].join(", ")}. You can
            still schedule if that's intended.
          </p>
        )}

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