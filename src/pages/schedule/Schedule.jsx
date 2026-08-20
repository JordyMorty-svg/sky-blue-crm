import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { useAuth } from "../../context/useAuth";
import { fetchMyJobs } from "../../services/jobService";
import { fetchCalendarJobs } from "../../services/calendarService";
import EventEditor from "./EventEditor";
import JobPlanTag from "../../components/JobPlanTag";
import ViewSwitcher from "../../components/ViewSwitcher";
import {
  MAPS_APPS,
  navigationUrl,
  needsMapsChoice,
  openNavigation,
  placeForJob,
  readMapsPref,
  setMapsPref,
  clearMapsPref,
} from "../../components/navigation";
import { SCHEDULE_VIEWS } from "../../components/navViews";
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
  const navigate = useNavigate();
  // Mode comes from the route rather than local state, so the view is
  // linkable, survives a refresh, and can be remembered between visits.
  const { pathname, state } = useLocation();
  const nextVisit = state?.nextVisit || null;
  const mode = pathname.startsWith("/schedule/calendar") ? "calendar" : "schedule";
  const [selectedDay, setSelectedDay] = useState(new Date());
  const [jobs, setJobs] = useState([]);
  const [calJobs, setCalJobs] = useState([]);
  const [calView, setCalView] = useState("week");
  const [calDate, setCalDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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

  function handleComplete(job) {
    // Go to the completion page to record amount + payment method,
    // which then calls completeJob with the full details.
    navigate(`/schedule/complete/${job.id}`);
  }

  // Which maps app to hand an address to.
  //
  // Android answers this itself via a geo: link, so this only ever matters
  // on iOS, where there is no OS-level default to read. Asked once, then
  // remembered — see components/navigation.js.
  const [mapsApp, setMapsApp] = useState(() => readMapsPref());
  const [choosingFor, setChoosingFor] = useState(null);

  function handleNavigate(job) {
    const place = placeForJob(job);
    if (!place.address && place.latitude == null) return;

    if (needsMapsChoice()) {
      setChoosingFor(job);
      return;
    }
    openNavigation(navigationUrl(place));
  }

  // Picked from the chooser: remember it, then go straight there so the
  // choice doesn't cost an extra journey.
  function handlePickMapsApp(key) {
    setMapsPref(key);
    setMapsApp(key);
    const job = choosingFor;
    setChoosingFor(null);
    if (job) openNavigation(navigationUrl(placeForJob(job), key));
  }

  function handleForgetMapsApp() {
    clearMapsPref();
    setMapsApp(null);
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
      {/* The switcher is the visible heading; the h1 is kept for screen
          readers and the document outline. Same pattern as the leads pages. */}
      <h1 className="visually-hidden">My schedule</h1>
      <ViewSwitcher views={SCHEDULE_VIEWS} section="schedule" />

      {error && <p className="schedule__error">{error}</p>}

      {nextVisit && (
        <p className="schedule__nextvisit">
          Next visit booked for {nextVisit.name} —{" "}
          {new Date(nextVisit.startsAt).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}{" "}
          at ${nextVisit.price}. It's on the Jobs board if you need to move it.
        </p>
      )}

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

          {/* Only on iOS, and only once a choice has been made — Android
              routes through its own default and needs nothing here. */}
          {mapsApp && (
            <p className="schedule__mapspref">
              Directions open in{" "}
              <strong>
                {MAPS_APPS.find((a) => a.key === mapsApp)?.label || mapsApp}
              </strong>
              <button
                className="schedule__mapschange"
                onClick={handleForgetMapsApp}
              >
                Change
              </button>
            </p>
          )}

          {dayJobs.length === 0 ? (
            <p className="schedule__empty">No jobs scheduled for you this day.</p>
          ) : (
            <div className="schedule__list">
              {dayJobs.map((job) => (
                <div className="schedjob" key={job.id}>
                  <div className="schedjob__time">{formatTime(job.starts_at)}</div>
                  <div className="schedjob__body">
                    <div className="schedjob__name">
                      {job.lead?.name || job.customer?.name || "Job"}
                    </div>
                    <div className="schedjob__addr">
                      {job.lead?.address || job.customer?.address}
                    </div>
                    <div className="schedjob__meta">
                      {job.lead?.phone || job.customer?.phone} · ${job.price} ·{" "}
                      {job.duration_hours}h
                    </div>
                    {job.notes && <div className="schedjob__notes">{job.notes}</div>}
                    <div className="schedjob__crew">
                      {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                    </div>
                    <div className="schedjob__tags">
                      <JobPlanTag job={job} />
                    </div>
                  </div>
                  <div className="schedjob__actions">
                    {/* First in the stack because it's the one you need
                        before arriving; the other two are for afterwards. */}
                    <button
                      className="schedjob__nav"
                      onClick={() => handleNavigate(job)}
                      disabled={!placeForJob(job).address}
                    >
                      Navigate
                    </button>
                    <button
                      className="schedjob__complete"
                      onClick={() => handleComplete(job)}
                    >
                      Mark completed
                    </button>
                    <button
                      className="schedjob__edit"
                      onClick={() =>
                        // pathname, not a literal, so it returns to
                        // whichever schedule view you were looking at.
                        navigate(`/jobs/${job.id}`, {
                          state: { from: pathname },
                        })
                      }
                    >
                      Edit
                    </button>
                  </div>
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

      {/* Asked once per phone, then never again. iOS has no default maps
          app to read outside the EU, so the CRM keeps the preference the
          OS won't — see components/navigation.js. */}
      {choosingFor && (
        <div
          className="mapspick"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a maps app"
        >
          <div className="mapspick__card">
            <h2 className="mapspick__title">Open directions in</h2>
            <p className="mapspick__sub">
              {placeForJob(choosingFor).address}
            </p>
            <div className="mapspick__options">
              {MAPS_APPS.map((a) => (
                <button
                  key={a.key}
                  className="mapspick__option"
                  onClick={() => handlePickMapsApp(a.key)}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="mapspick__note">
              Remembered on this phone. You can change it above the day's
              jobs.
            </p>
            <button
              className="mapspick__cancel"
              onClick={() => setChoosingFor(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}