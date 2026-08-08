import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import {
  fetchBookedLeads,
  fetchScheduledJobs,
  fetchTechs,
} from "../../services/jobService";
import TechPicker from "../../components/TechPicker";
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

const RANGES = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom range" },
];

// Whether `iso` falls in the selected preset/custom range.
function inRange(iso, range, customStart, customEnd) {
  if (range === "all") return true;
  if (!iso) return false;

  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (range === "today") {
    const end = new Date(startOfToday);
    end.setDate(end.getDate() + 1);
    return d >= startOfToday && d < end;
  }
  if (range === "week") {
    const end = new Date(startOfToday);
    end.setDate(end.getDate() + 7);
    return d >= startOfToday && d < end;
  }
  if (range === "month") {
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return d >= startOfToday && d < end;
  }
  if (range === "custom") {
    if (!customStart) return true;
    const start = new Date(
      customStart.getFullYear(), customStart.getMonth(), customStart.getDate()
    );
    // If no end chosen, treat as single-day; else inclusive of end day.
    const endBase = customEnd || customStart;
    const end = new Date(
      endBase.getFullYear(), endBase.getMonth(), endBase.getDate() + 1
    );
    return d >= start && d < end;
  }
  return true;
}

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem("jobsCollapsed")) || {};
  } catch {
    return {};
  }
}

export default function Jobs() {
  const navigate = useNavigate();
  const [booked, setBooked] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [range, setRange] = useState("all");
  const [customStart, setCustomStart] = useState(null);
  const [customEnd, setCustomEnd] = useState(null);
  const [techFilter, setTechFilter] = useState([]); // tech ids; empty = all
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    localStorage.setItem("jobsCollapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  async function load() {
    try {
      setLoading(true);
      const [b, j, t] = await Promise.all([
        fetchBookedLeads(),
        fetchScheduledJobs(),
        fetchTechs(),
      ]);
      setBooked(b);
      setJobs(j);
      setTechs(t);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load jobs.");
    } finally {
      setLoading(false);
    }
  }

  function toggle(section) {
    setCollapsed((cur) => ({ ...cur, [section]: !cur[section] }));
  }

  if (loading) return <div className="jobs__state">Loading…</div>;

  const visibleJobs = jobs.filter((job) => {
    if (!inRange(job.starts_at, range, customStart, customEnd)) return false;
    if (techFilter.length > 0) {
      const jobTechIds = (job.assignments || []).map((a) => a.tech?.id);
      if (!techFilter.some((id) => jobTechIds.includes(id))) return false;
    }
    return true;
  });

  return (
    <div className="jobs">
      {error && <p className="jobs__error">{error}</p>}

      {/* To schedule */}
      <section className="jobs__section">
        <button className="jobs__head jobs__head--toggle" onClick={() => toggle("toSchedule")}>
          <span className="jobs__arrow">{collapsed.toSchedule ? "▸" : "▾"}</span>
          <h2 className="jobs__title">To schedule</h2>
          <span className="jobs__count">{booked.length}</span>
        </button>
        {!collapsed.toSchedule && (
          booked.length === 0 ? (
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
                  <button
                    className="jobrow__btn"
                    onClick={() => navigate(`/jobs/schedule/${lead.id}`)}
                  >
                    Schedule
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </section>

      {/* Scheduled jobs */}
      <section className="jobs__section">
        <button className="jobs__head jobs__head--toggle" onClick={() => toggle("scheduled")}>
          <span className="jobs__arrow">{collapsed.scheduled ? "▸" : "▾"}</span>
          <h2 className="jobs__title">Scheduled jobs</h2>
          <span className="jobs__count">{visibleJobs.length}</span>
        </button>

        {!collapsed.scheduled && (
          <>
            <div className="jobs__filters">
              <div className="jobs__ranges">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    className={`jobs__range ${range === r.key ? "jobs__range--active" : ""}`}
                    onClick={() => setRange(r.key)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              {range === "custom" && (
                <div className="jobs__customrange">
                  <DatePicker
                    selectsRange
                    startDate={customStart}
                    endDate={customEnd}
                    onChange={([start, end]) => {
                      setCustomStart(start);
                      setCustomEnd(end);
                    }}
                    dateFormat="MMM d, yyyy"
                    placeholderText="Pick a start and end date"
                    className="jobs__rangeinput"
                    isClearable
                  />
                </div>
              )}

              <div className="jobs__techfilter">
                <label className="jobs__filterlabel">Filter by team member</label>
                <TechPicker
                  techs={techs}
                  selectedIds={techFilter}
                  onChange={setTechFilter}
                />
              </div>
            </div>

            {visibleJobs.length === 0 ? (
              <p className="jobs__empty">No jobs match these filters.</p>
            ) : (
              <div className="jobs__list">
                {visibleJobs.map((job) => (
                  <div
                    className="jobrow jobrow--clickable"
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    role="button"
                    tabIndex={0}
                  >
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
          </>
        )}
      </section>
    </div>
  );
}