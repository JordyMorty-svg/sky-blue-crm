import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchJob,
  updateJob,
  updateJobTechs,
  fetchTechs,
} from "../../services/jobService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import TechPicker from "../../components/TechPicker";
import "./JobDetail.css";

export default function JobDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [techs, setTechs] = useState([]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  const [originalTechs, setOriginalTechs] = useState([]);
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [duration, setDuration] = useState(3);
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [jobData, techData] = await Promise.all([fetchJob(id), fetchTechs()]);
      setJob(jobData);
      setTechs(techData);

      const assigned = (jobData.assignments || []).map((a) => a.tech_id);
      setSelectedTechs(assigned);
      setOriginalTechs(assigned);

      const { date, time } = splitFromISO(jobData.starts_at);
      setApptDate(date);
      setApptTime(time);
      setDuration(jobData.duration_hours ?? 3);
      setPrice(jobData.price ?? "");
      setNotes(jobData.notes ?? "");
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this job.");
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
  }, [id]);

  async function handleSave() {
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
      await updateJob(id, {
        starts_at: combineToISO(apptDate, apptTime),
        duration_hours: Number(duration),
        price: Number(price) || 0,
        notes: notes || null,
      });
      await updateJobTechs(id, originalTechs, selectedTechs);
      navigate("/jobs");
    } catch (e) {
      console.error(e);
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  if (loading) return <div className="jobDetail__state">Loading…</div>;
  if (!job) return <div className="jobDetail__state">{error || "Not found."}</div>;

  return (
    <div className="jobDetail">
      <button className="jobDetail__back" onClick={() => navigate("/jobs")}>
        ← Back to jobs
      </button>

      <h1 className="jobDetail__title">{job.lead?.name || "Job"}</h1>

      <div className="jobDetail__lead">
        <span>{job.lead?.address || "No address"}</span>
        <span>{job.lead?.phone}</span>
        <span>{job.services}</span>
      </div>

      {error && <p className="jobDetail__error">{error}</p>}

      <div className="jobDetail__form">
        <AppointmentPicker
          date={apptDate}
          time={apptTime}
          onDateChange={setApptDate}
          onTimeChange={setApptTime}
        />

        <label className="jobDetail__label">Estimated duration (hours)</label>
        <input
          className="jobDetail__input"
          type="number"
          step="0.5"
          min="0.5"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />

        <label className="jobDetail__label">Price ($)</label>
        <input
          className="jobDetail__input"
          type="number"
          min="0"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />

        <label className="jobDetail__label">Assigned team members</label>
        <TechPicker
          techs={techs}
          selectedIds={selectedTechs}
          onChange={setSelectedTechs}
        />

        <label className="jobDetail__label">Notes</label>
        <textarea
          className="jobDetail__input jobDetail__textarea"
          rows="3"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Gate code, dog in yard, access instructions…"
        />

        <div className="jobDetail__actions">
          <button className="jobDetail__save" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button className="jobDetail__cancel" onClick={() => navigate("/jobs")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}