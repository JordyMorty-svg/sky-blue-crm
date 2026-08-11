import { useEffect, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { useAuth } from "../../context/AuthContext";
import { useNavigate } from "react-router-dom";
import { fetchMyJobs } from "../../services/jobService";
import "./Schedule.css";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

// Calendar day window: 7:00 AM to 9:00 PM.
const DAY_MIN = new Date(1970, 0, 1, 7, 0, 0);
const DAY_MAX = new Date(1970, 0, 1, 21, 0, 0);

function sameDay(iso, day) {
  if (!iso) return false;
  const d = new Date(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Custom toolbar — our own buttons driving view/navigation directly,
// so switching never depends on react-big-calendar's internal toolbar.
function CalendarToolbar({ label, onNavigate, onView, view }) {
  const views = [
    { key: "day", label: "Day" },
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
  ];
  return (
    <div className="calbar">
      <div className="calbar__nav">
        <button onClick={() => onNavigate("TODAY")}>Today</button>
        <button onClick={() => onNavigate("PREV")}>‹</button>
        <button onClick={() => onNavigate("NEXT")}>›</button>
      </div>
      <span className="calbar__label">{label}</span>
      <div className="calbar__views">
        {views.map((v) => (
          <button
            key={v.key}
            className={view === v.key ? "calbar__view--active" : ""}
            onClick={() => onView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Schedule() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState("schedule"); // 'schedule' | 'calendar'
  const [selectedDay, setSelectedDay] = useState(new Date());
  const [calDate, setCalDate] = useState(new Date());   // calendar's current date
  const [calView, setCalView] = useState("week");        // calendar's current view
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchMyJobs(user.id);
      setJobs(data);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load your schedule.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="schedule__state">Loading your schedule…</div>;

  const dayJobs = jobs.filter((j) => sameDay(j.starts_at, selectedDay));

  const events = jobs
    .filter((j) => j.starts_at)
    .map((j) => {
      const start = new Date(j.starts_at);
      const end = new Date(start.getTime() + (j.duration_hours || 3) * 3600000);
      return {
        id: j.id,
        title: `${j.lead?.name || "Job"} — ${j.lead?.address || ""}`,
        start,
        end,
      };
    });

  return (
    <div className="schedule">
      <div className="schedule__head">
        <h1 className="schedule__title">My schedule</h1>
        <select
          className="schedule__mode"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="schedule">Schedule (daily)</option>
          <option value="calendar">Calendar</option>
        </select>
      </div>

      {error && <p className="schedule__error">{error}</p>}

      {mode === "schedule" ? (
        <div className="schedule__day">
          <div className="schedule__daypick">
            <DatePicker
              selected={selectedDay}
              onChange={(d) => setSelectedDay(d || new Date())}
              dateFormat="EEEE, MMMM d"
              className="schedule__dateinput"
            />
            <button
              className="schedule__today"
              onClick={() => setSelectedDay(new Date())}
            >
              Today
            </button>
          </div>

          {dayJobs.length === 0 ? (
            <p className="schedule__empty">No jobs scheduled for you this day.</p>
          ) : (
            <div className="schedule__list">
              {dayJobs.map((job) => (
                <div className="schedjob" key={job.id}>
                  <div className="schedjob__time">{formatTime(job.starts_at)}</div>
                  <div className="schedjob__body">
                    <div className="schedjob__name">{job.lead?.name || "Job"}</div>
                    <div className="schedjob__addr">{job.lead?.address}</div>
                    <div className="schedjob__meta">
                      {job.lead?.phone} · ${job.price} · {job.duration_hours}h
                    </div>
                    {job.notes && <div className="schedjob__notes">{job.notes}</div>}
                    <div className="schedjob__crew">
                      {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                    </div>
                  </div>
                  <button
                    className="schedjob__complete"
                    onClick={() => navigate(`/schedule/complete/${job.id}`)}
                  >
                    Mark completed
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="schedule__calendar">
          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            date={calDate}
            view={calView}
            onNavigate={(newDate) => setCalDate(newDate)}
            onView={(newView) => setCalView(newView)}
            views={["day", "week", "month"]}
            components={{ toolbar: CalendarToolbar }}
            min={DAY_MIN}
            max={DAY_MAX}
            style={{ height: 640 }}
          />
        </div>
      )}
    </div>
  );
}