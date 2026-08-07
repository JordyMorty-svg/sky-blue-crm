import { useEffect, useState } from "react";
import {
  fetchBookedLeads,
  fetchScheduledJobs,
} from "../../services/jobService";
import ScheduleJobModal from "./ScheduleJobModal";
import "./Jobs.css";

function formatWhen(iso) {
  if (!iso) return "No time set";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Jobs() {
  const [booked, setBooked] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scheduling, setScheduling] = useState(null); // lead being scheduled

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const [b, j] = await Promise.all([fetchBookedLeads(), fetchScheduledJobs()]);
      setBooked(b);
      setJobs(j);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load jobs.");
    } finally {
      setLoading(false);
    }
  }

  function handleScheduled() {
    setScheduling(null);
    load(); // refresh both lists
  }

  if (loading) return <div className="jobs__state">Loading…</div>;

  return (
    <div className="jobs">
      {error && <p className="jobs__error">{error}</p>}

      {/* To schedule */}
      <section className="jobs__section">
        <div className="jobs__head">
          <h2 className="jobs__title">To schedule</h2>
          <span className="jobs__count">{booked.length}</span>
        </div>
        {booked.length === 0 ? (
          <p className="jobs__empty">No booked leads waiting. Nice.</p>
        ) : (
          <div className="jobs__list">
            {booked.map((lead) => (
              <div className="jobrow" key={lead.id}>
                <div className="jobrow__main">
                  <span className="jobrow__name">{lead.name}</span>
                  <span className="jobrow__meta">
                    {lead.address || "No address"} · ${lead.estimate}
                  </span>
                  <span className="jobrow__when">{formatWhen(lead.appointment_at)}</span>
                </div>
                <button className="jobrow__btn" onClick={() => setScheduling(lead)}>
                  Schedule
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Scheduled jobs */}
      <section className="jobs__section">
        <div className="jobs__head">
          <h2 className="jobs__title">Scheduled jobs</h2>
          <span className="jobs__count">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <p className="jobs__empty">No scheduled jobs yet.</p>
        ) : (
          <div className="jobs__list">
            {jobs.map((job) => (
              <div className="jobrow" key={job.id}>
                <div className="jobrow__main">
                  <span className="jobrow__name">{job.lead?.name || "Job"}</span>
                  <span className="jobrow__meta">
                    {job.lead?.address || "No address"} · ${job.price} · {job.duration_hours}h
                  </span>
                  <span className="jobrow__when">{formatWhen(job.starts_at)}</span>
                  <span className="jobrow__techs">
                    {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ") || "Unassigned"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {scheduling && (
        <ScheduleJobModal
          lead={scheduling}
          onClose={() => setScheduling(null)}
          onScheduled={handleScheduled}
        />
      )}
    </div>
  );
}