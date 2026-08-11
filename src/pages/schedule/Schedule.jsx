import { useEffect, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { useAuth } from "../../context/AuthContext";
import { fetchMyJobs, completeJob } from "../../services/jobService";
import { fetchCalendarJobs } from "../../services/calendarService";
import EventEditor from "./EventEditor";
import "./Schedule.css";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

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
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Clean custom toolbar (replaces react-big-calendar's dated default).
function CalendarToolbar({ label, onNavigate, onView, view }) {
  return (
    <div className="rbc-custom-toolbar">
      <div className="rbc-custom-toolbar__nav">
        <button onClick={() => onNavigate("TODAY")} className="rbc-custom-toolbar__today">
          Today
        </button>
        <button onClick={() => onNavigate("PREV")} className="rbc-custom-toolbar__arrow">‹</button>
        <button onClick={() => onNavigate("NEXT")} className="rbc-custom-toolbar__arrow">›</button>
      </div>
      <span className="rbc-custom-toolbar__label">{label}</span>
      <div className="rbc-custom-toolbar__views">
        {["day", "week", "month"].map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            className={`rbc-custom-toolbar__view ${view === v ? "is-active" : ""}`}
          >
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Schedule() {
  const { user } = useAuth();
  const [mode, setMode] = useState("schedule");
  const [selectedDay, setSelectedDay] = useState(new Date());
  const [jobs, setJobs] = useState([]);
  const [calJobs, setCalJobs] = useState([]);
  const [calView, setCalView] = useState("week");
  const [calDate, setCalDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [completing, setCompleting] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);

  useEffect(() => {
    if (user?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function load() {
    try {
      setLoading(true);
      const [mine, all] = await Promise.all([
        fetchMyJobs(user.id),
        fetchCalendarJobs(),
      ]);
      setJobs(mine);
      setCalJobs(all);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load your schedule.");
    } finally {
      setLoading(false);
    }
  }

  async function handleComplete(job) {
    setCompleting(job.id);
    try {
      await completeJob(job);
      setJobs((cur) => cur.filter((j) => j.id !== job.id));
      load(); // refresh calendar so it reflects the new completed status
    } catch (e) {
      console.error(e);
      setError("Couldn't mark completed. Try again.");
    } finally {
      setCompleting(null);
    }
  }

  if (loading) return <div className="schedule__state">Loading your schedule…</div>;

  const dayJobs = jobs.filter((j) => sameDay(j.starts_at, selectedDay));

  const events = calJobs.map((j) => {
    const start = new Date(j.starts_at);
    const end = new Date(start.getTime() + (j.duration_hours || 3) * 3600000);
    const who = j.lead?.name || j.customer?.name || "Job";
    return {
      id: j.id,
      title: who,
      start,
      end,
      status: j.status,
      duration_hours: j.duration_hours || 3,
    };
  });

  // Color events by status: scheduled = blue, completed = light green.
  function eventStyle(event) {
    const isDone = event.status === "completed";
    return {
      style: {
        backgroundColor: isDone ? "#dcfce7" : "#2563eb",
        color: isDone ? "#166534" : "#ffffff",
        border: isDone ? "1px solid #86efac" : "1px solid #1d4ed8",
        borderRadius: "8px",
        padding: "2px 6px",
        fontSize: "0.8rem",
        fontWeight: 600,
        boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
      },
    };
  }

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
            <button className="schedule__today" onClick={() => setSelectedDay(new Date())}>
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
                    onClick={() => handleComplete(job)}
                    disabled={completing === job.id}
                  >
                    {completing === job.id ? "…" : "Mark completed"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="schedule__calendar">
          <div className="schedule__legend">
            <span className="schedule__legend-item">
              <span className="schedule__legend-dot" style={{ background: "#2563eb" }} />
              Scheduled
            </span>
            <span className="schedule__legend-item">
              <span className="schedule__legend-dot" style={{ background: "#dcfce7", border: "1px solid #86efac" }} />
              Completed
            </span>
          </div>
          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            view={calView}
            onView={setCalView}
            date={calDate}
            onNavigate={setCalDate}
            views={["day", "week", "month"]}
            min={DAY_MIN}
            max={DAY_MAX}
            eventPropGetter={eventStyle}
            onSelectEvent={(event) => setEditingEvent(event)}
            onDrillDown={(date) => {
              setCalDate(date);
              setCalView("day");
            }}
            onSelectSlot={(slot) => {
              if (calView === "month") {
                setCalDate(slot.start);
                setCalView("day");
              }
            }}
            selectable
            components={{ toolbar: CalendarToolbar }}
            style={{ height: 680 }}
          />
        </div>
      )}

      {editingEvent && (
        <EventEditor
          event={editingEvent}
          onClose={() => setEditingEvent(null)}
          onSaved={() => {
            setEditingEvent(null);
            load();
          }}
        />
      )}
    </div>
  );
}