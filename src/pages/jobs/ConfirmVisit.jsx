import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchJob, fetchTechs, confirmVisit } from "../../services/jobService";
import { planFor } from "../../services/leadService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import TechPicker from "../../components/TechPicker";
import DayPreview from "./DayPreview";
import "./ScheduleJob.css";

/**
 * Turns a due recurring visit into a scheduled job.
 *
 * Deliberately separate from ScheduleJob: that one creates a job from a
 * lead, this one confirms a job that already exists. The date is
 * pre-filled with the plan's due date and is meant to be nudged.
 */
export default function ConfirmVisit() {
  const { jobId } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
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
      const [jobData, techData] = await Promise.all([
        fetchJob(jobId),
        fetchTechs(),
      ]);
      setJob(jobData);
      setTechs(techData);
      setDuration(jobData.duration_hours || 3);
      setNotes(jobData.notes || "");
      const { date, time } = splitFromISO(jobData.starts_at);
      setApptDate(date);
      setApptTime(time);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this visit.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!apptDate || !apptTime) {
      setError("Set a date and time.");
      return;
    }
    if (selectedTechs.length === 0) {
      setError("Assign at least one team member.");
      return;
    }

    setSaving(true);
    try {
      await confirmVisit(jobId, {
        startsAt: combineToISO(apptDate, apptTime),
        durationHours: Number(duration),
        techIds: selectedTechs,
        notes,
      });
      navigate("/jobs");
    } catch (e) {
      console.error(e);
      setError("Couldn't schedule this visit. Try again.");
      setSaving(false);
    }
  }

  if (loading) return <div className="scheduleJob__state">Loading…</div>;
  if (!job) return <div className="scheduleJob__state">{error || "Not found."}</div>;

  const who = job.customer?.name || job.lead?.name || "Customer";
  const plan = planFor(job.service_plan);

  return (
    <div className="scheduleJob">
      <button className="scheduleJob__back" onClick={() => navigate("/jobs")}>
        ← Back to jobs
      </button>

      <h1 className="scheduleJob__title">Schedule recurring visit</h1>

      <div className="scheduleJob__lead">
        <strong>{who}</strong>
        <span>{job.customer?.address || job.lead?.address || "No address"}</span>
        <span>{job.customer?.phone || job.lead?.phone}</span>
        <span>
          {plan.label} plan · visit {job.visit_number} · ${job.price}
        </span>
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
          <p className="scheduleJob__hint">
            Pre-filled with the plan's due date — move it a day or two if that
            suits the round better.
          </p>
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
          <label className="scheduleJob__label">Day preview &amp; conflicts</label>
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
            {saving ? "Scheduling…" : "Schedule visit"}
          </button>
        </div>
      </form>
    </div>
  );
}
