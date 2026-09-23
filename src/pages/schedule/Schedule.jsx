import { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import {
  format,
  parse,
  startOfWeek,
  endOfWeek,
  addDays,
  isSameDay,
  getDay,
} from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { useAuth } from "../../context/useAuth";
import { fetchMyJobs } from "../../services/jobService";
import { fetchCalendarJobs } from "../../services/calendarService";
import { can } from "../../components/capabilities";
import JobPlanTag from "../../components/JobPlanTag";
import ViewSwitcher from "../../components/ViewSwitcher";
import {
  remember,
  recall,
  rememberDay,
  recallDay,
} from "../../components/viewMemory";
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

// Below this, a seven-column time grid stops being a calendar and starts
// being a word search: each column is about 45px, so names wrap one letter
// at a time and the grid pushes the whole page sideways.
const NARROW_QUERY = "(max-width: 700px)";

function useIsNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return narrow;
}

// A column in the week view is about 107px. "9:00 AM – 12:00 PM" needs
// roughly twice that, so it was being cut mid-word on every single event.
// The end time is already implied by how far the block reaches down the
// grid, which is the entire point of a time grid — so show the start and
// let the shape say the rest.
const CAL_FORMATS = {
  eventTimeRangeFormat: ({ start }) => format(start, "h:mm a"),
  // Month spelled weekdays out in full while Week abbreviated them, so the
  // header changed shape when you switched. Short in both.
  weekdayFormat: (date) => format(date, "EEE"),
};

// Day view has one column and the whole page to draw it in, so the argument
// above doesn't apply: there is room for the finish time, and knowing when
// you're free again is most of why you open a single day.
const DAY_FORMATS = {
  ...CAL_FORMATS,
  eventTimeRangeFormat: ({ start, end }) =>
    `${format(start, "h:mm a")} – ${format(end, "h:mm a")}`,
};

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

// Month chips on a phone.
//
// A month column at 390px is about 48px wide, which fits roughly six
// characters. "Nibler Joseph" truncates to "Nib…" — enough to know
// something is there, never enough to know what — so show the first name
// and let it be a whole word. "Shane mcshane" becomes "Shane", which is
// how you'd say it out loud anyway.
function MonthEvent({ event }) {
  const first = String(event?.title || "").trim().split(/\s+/)[0] || "Job";
  return <span className="rbcmonth__label">{first}</span>;
}

// Inside a block on the Day grid.
//
// One day is one column, and one column is the width of the page — so a
// three-hour job was a 780x144 rectangle containing a name and a start time
// in its top-left corner and nothing else. The block is that size whatever
// we put in it; the only question is whether it says anything.
//
// Who, where, and who's going are the three things you open a day to check,
// and the grid itself has already answered when. The address and the crew
// go in whenever the block is tall enough for the extra lines — an hour and
// a half of work — because clipping a street name halfway through is worse
// than not starting it.
function DayEvent({ event }) {
  const tall = (event.duration_hours || 0) >= 1.5;
  return (
    <span className="dayevent">
      <span className="dayevent__name">{event.title}</span>
      {tall && event.address && (
        <span className="dayevent__line">{event.address}</span>
      )}
      {tall && event.crew && (
        <span className="dayevent__line">{event.crew}</span>
      )}
    </span>
  );
}

// The toolbar for the phone list views. Same markup and classes as the
// react-big-calendar one so the two look identical when you switch — the
// grid views still use CalendarToolbar below.
function MobileCalToolbar({ label, onToday, onPrev, onNext, view, onView }) {
  return (
    <div className="rbc-custom-toolbar">
      <div className="rbc-custom-toolbar__nav">
        <button className="rbc-custom-toolbar__today" onClick={onToday}>
          Today
        </button>
        <button
          className="rbc-custom-toolbar__arrow"
          onClick={onPrev}
          aria-label="Previous"
        >
          ‹
        </button>
        <button
          className="rbc-custom-toolbar__arrow"
          onClick={onNext}
          aria-label="Next"
        >
          ›
        </button>
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

/**
 * The calendar, as a list, for phones. One day or seven.
 *
 * react-big-calendar's week view is a seven-column time grid. That's the
 * right shape on a laptop and the wrong one on a phone: seven columns in
 * 360px leaves ~45px each, so "Nibler Joseph" renders as a vertical
 * stack of single letters and the grid shoves the whole page sideways.
 *
 * A phone has one axis worth using — vertical — so this walks the range in
 * order and groups by day. Empty days are dropped rather than drawn: on a
 * grid a blank column carries meaning, but in a list it's just scrolling.
 *
 * The Day view has the same problem in a subtler form: a single column of
 * empty hours where the one job sits half-scrolled off the top, its name
 * invisible because the block starts above the viewport. Same fix.
 */
function MobileAgenda({ events, start, dayCount, onSelect }) {
  const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i));

  const withJobs = days
    .map((day) => ({
      day,
      jobs: events
        .filter((e) => isSameDay(e.start, day))
        .sort((a, b) => a.start - b.start),
    }))
    .filter((d) => d.jobs.length > 0);

  if (withJobs.length === 0) {
    return (
      <p className="schedule__empty">
        {dayCount === 1
          ? "Nothing scheduled this day."
          : "Nothing scheduled this week."}
      </p>
    );
  }

  return (
    <div className="weeklist">
      {withJobs.map(({ day, jobs }) => (
        <div className="weeklist__day" key={day.toISOString()}>
          {dayCount > 1 && (
          <div
            className={`weeklist__dayhead ${
              isSameDay(day, new Date()) ? "weeklist__dayhead--today" : ""
            }`}
          >
            <span className="weeklist__dayname">{format(day, "EEEE")}</span>
            <span className="weeklist__daydate">{format(day, "MMM d")}</span>
            <span className="weeklist__daycount">
              {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
            </span>
          </div>
          )}

          {jobs.map((job) => (
            <button
              className={`weeklist__job weeklist__job--${job.status}`}
              key={job.id}
              onClick={() => onSelect(job)}
            >
              <span className="weeklist__time">
                {format(job.start, "h:mm a")}
              </span>
              <span className="weeklist__body">
                <span className="weeklist__name">{job.title}</span>
                {job.address && (
                  <span className="weeklist__addr">{job.address}</span>
                )}
              </span>
              <span className={`weeklist__status weeklist__status--${job.status}`}>
                {job.status === "completed" ? "Done" : "Booked"}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
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
  const { user, role } = useAuth();
  // Owners see the whole team's calendar; everyone else sees only the
  // jobs they're assigned to.
  const seeAllJobs = can(role, "see_all_jobs");
  const navigate = useNavigate();
  // Mode comes from the route rather than local state, so the view is
  // linkable, survives a refresh, and can be remembered between visits.
  const { pathname, state } = useLocation();
  const nextVisit = state?.nextVisit || null;
  const mode = pathname.startsWith("/schedule/calendar") ? "calendar" : "schedule";
  // Remembered so that stepping into a customer and coming back doesn't
  // silently move you to today. recallDay only honours a date saved on
  // this same calendar day — see viewMemory.js for why.
  const [selectedDay, setSelectedDay] = useState(
    () => recallDay("scheduleDay") || new Date()
  );
  const [jobs, setJobs] = useState([]);
  const [calJobs, setCalJobs] = useState([]);
  const [calView, setCalView] = useState(() =>
    recall("calView", "week", ["day", "week", "month"])
  );
  const isNarrow = useIsNarrow();

  // Every place these three change goes through one of these, so there's
  // no path that updates the screen without recording it.
  function pickCalView(v) {
    setCalView(v);
    remember("calView", v);
  }

  function pickCalDate(d) {
    const next = d || new Date();
    setCalDate(next);
    rememberDay("calDate", next);
  }

  function pickDay(d) {
    const next = d || new Date();
    setSelectedDay(next);
    rememberDay("scheduleDay", next);
  }

  // Where a job on the calendar takes you.
  //
  // It used to open a popup that edited the date, time and duration and
  // nothing else — but the calendar has already told you the date and time
  // by where the block sits on the grid, so the one thing the popup added
  // was the one thing you could already see. It couldn't show the address,
  // the crew, the price or the notes, and it couldn't complete the job.
  //
  // Booked work opens the editor, which does everything the popup did and
  // the rest besides. Finished work opens its record, which is read-only
  // on purpose: there's a Square payment behind it that editing here would
  // silently contradict.
  function openEvent(event) {
    const path =
      event.status === "completed"
        ? `/jobs/record/${event.id}`
        : `/jobs/${event.id}`;
    // pathname, not a literal, so Back returns to whichever calendar view
    // you were looking at.
    navigate(path, { state: { from: pathname } });
  }

  // Memoised: a fresh `components` object on every render makes
  // react-big-calendar remount its internals.
  const calComponents = useMemo(
    () =>
      isNarrow
        ? {
            toolbar: CalendarToolbar,
            day: { event: DayEvent },
            month: { event: MonthEvent },
          }
        : { toolbar: CalendarToolbar, day: { event: DayEvent } },
    [isNarrow]
  );
  const [calDate, setCalDate] = useState(
    () => recallDay("calDate") || new Date()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // `seeAllJobs` is in the deps, not just user.id. The profile (and so the
  // role) resolves a beat after the session does, and without this the first
  // load would run as the default role and hand a tech the whole team's
  // calendar until something else happened to refetch.
  useEffect(() => {
    if (user?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, seeAllJobs]);

  async function load() {
    try {
      setLoading(true);
      const [mine, all] = await Promise.all([
        // Finished work stays on the day it was done. A day that empties
        // itself as you work through it can't answer "what's left?" — by
        // mid-afternoon it looks the same as a day with nothing booked,
        // and there's no way to check what you already did without going
        // looking for it. Cancelled jobs are still left out: those came
        // off the schedule, which is the point of cancelling one.
        fetchMyJobs(user.id, { statuses: ["scheduled", "completed"] }),
        fetchCalendarJobs(seeAllJobs ? null : user.id),
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
  const doneCount = dayJobs.filter((j) => j.status === "completed").length;

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
      // Read by the phone's week list and by the Day grid, both of which
      // have room for a second line. The week grid does not, and doesn't
      // ask for it.
      address: j.customer?.address || j.lead?.address || "",
      crew: (j.assignments || [])
        .map((a) => a.tech?.full_name)
        .filter(Boolean)
        .join(", "),
    };
  });

  // Colour events by status: scheduled = blue, completed = light green.
  //
  // A class, not an inline style. Every one of those nine inline properties
  // was a thing competing with the four react-big-calendar sets itself —
  // `top`, `height`, `left`, `width` — and one of them, a width override,
  // is what used to push a second concurrent job into the next day.
  //
  // Keeping the look in one CSS rule is also the only way the three views
  // can be guaranteed to match. They didn't: an earlier attempt at a gap
  // between blocks used clip-path, which trimmed the right and bottom off
  // the outline and took the drop shadow with it — so the same job had
  // half an outline in Week and a whole one in Month, and Month read as
  // the darker view.
  function eventClass(event) {
    const kind = event.status === "completed" ? "done" : "booked";
    return { className: `calevent calevent--${kind}` };
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
              onChange={(d) => pickDay(d)}
              dateFormat="EEEE, MMMM d"
              className="schedule__dateinput"
            />
            <button className="schedule__today" onClick={() => pickDay(new Date())}>
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
              {/* The reason finished jobs stay: the day can now say how far
                  through it you are. A list that deletes what you've done
                  can't — by three o'clock it looks like a quiet day rather
                  than a finished one. */}
              <p className="schedule__progress">
                {doneCount === dayJobs.length
                  ? `All ${dayJobs.length} done.`
                  : `${doneCount} of ${dayJobs.length} done`}
              </p>
              {dayJobs.map((job) => {
                const done = job.status === "completed";
                return (
                <div
                  className={`schedjob ${done ? "schedjob--done" : ""}`}
                  key={job.id}
                >
                  <div className="schedjob__time">{formatTime(job.starts_at)}</div>
                  <div className="schedjob__body">
                    <div className="schedjob__name">
                      {/* The tick, not a word. Standing in a driveway with
                          the phone at arm's length, the question is "have I
                          done this one?" and a mark answers it faster than a
                          label you have to read. */}
                      {done && (
                        <span className="schedjob__tick" aria-hidden="true">
                          ✓
                        </span>
                      )}
                      {job.lead?.name || job.customer?.name || "Job"}
                      {done && <span className="visually-hidden"> — completed</span>}
                    </div>
                    <div className="schedjob__addr">
                      {job.lead?.address || job.customer?.address}
                    </div>
                    <div className="schedjob__meta">
                      {/* Tappable: standing at the door and needing to ring
                          the customer is the commonest reason anyone reads
                          this line. */}
                      {(job.lead?.phone || job.customer?.phone) && (
                        <>
                          <a
                            className="schedjob__phone"
                            href={`tel:${String(
                              job.lead?.phone || job.customer?.phone
                            ).replace(/[^\d+]/g, "")}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {job.lead?.phone || job.customer?.phone}
                          </a>
                          {" · "}
                        </>
                      )}
                      {/* Once it's done, what they actually paid is the
                          true number — the quote is a guess that's been
                          overtaken. `final_price` is only written on
                          completion, so the fallback isn't hypothetical for
                          jobs finished before that column existed. */}
                      ${done ? (job.final_price ?? job.price) : job.price} ·{" "}
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
                  {/* A finished job gets one control, not three. Directions
                      to a house you've already left are noise, "Mark
                      completed" on something already completed is a trap,
                      and the editor would let you rewrite the price of work
                      that has a Square payment behind it. Its record is
                      read-only for exactly that reason — same routing the
                      calendar uses. */}
                  <div className="schedjob__actions">
                    {done ? (
                      <button
                        className="schedjob__edit"
                        onClick={() =>
                          navigate(`/jobs/record/${job.id}`, {
                            state: { from: pathname },
                          })
                        }
                      >
                        View record
                      </button>
                    ) : (
                      <>
                        {/* First in the stack because it's the one you need
                            before arriving; the other two are for
                            afterwards. */}
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
                      </>
                    )}
                  </div>
                </div>
                );
              })}
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
          {/* Neither grid works at phone width. The week is seven columns
              of ~45px; the day is one column of mostly-empty hours with the
              job's name scrolled off the top. Both become lists. Month is
              the one grid that survives — it's a shape, not text. */}
          {isNarrow && calView !== "month" ? (
            <>
              <MobileCalToolbar
                view={calView}
                onView={pickCalView}
                onToday={() => pickCalDate(new Date())}
                onPrev={() =>
                  pickCalDate(addDays(calDate, calView === "day" ? -1 : -7))
                }
                onNext={() =>
                  pickCalDate(addDays(calDate, calView === "day" ? 1 : 7))
                }
                label={
                  calView === "day"
                    ? format(calDate, "EEEE, MMMM d")
                    : `${format(
                        startOfWeek(calDate, { weekStartsOn: 0 }),
                        "MMMM d"
                      )} – ${format(
                        endOfWeek(calDate, { weekStartsOn: 0 }),
                        "d"
                      )}`
                }
              />

              <MobileAgenda
                events={events}
                start={
                  calView === "day"
                    ? calDate
                    : startOfWeek(calDate, { weekStartsOn: 0 })
                }
                dayCount={calView === "day" ? 1 : 7}
                onSelect={openEvent}
              />
            </>
          ) : (
          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            view={calView}
            onView={pickCalView}
            date={calDate}
            onNavigate={pickCalDate}
            views={["day", "week", "month"]}
            formats={calView === "day" ? DAY_FORMATS : CAL_FORMATS}
            min={DAY_MIN}
            max={DAY_MAX}
            // Overlapping blocks, not a split column.
            //
            // "no-overlap" was tried first, and it is the more orderly of
            // the two: two jobs that clash each take half the column and
            // never touch. The trouble is that they take half the column
            // for their WHOLE length, so a 9am job that runs half an hour
            // into a noon booking spends the entire morning drawn at half
            // width with nothing beside it — and the day reads as broken
            // rather than as double-booked.
            //
            // Here the first job keeps most of the column and the second is
            // laid over its tail. The overlap is the point: the only reason
            // the drawing is untidy is that the bookings are, and a clash
            // you can see at a glance is worth more than a tidy grid.
            dayLayoutAlgorithm="overlap"
            eventPropGetter={eventClass}
            onSelectEvent={openEvent}
            onDrillDown={(date) => {
              pickCalDate(date);
              pickCalView("day");
            }}
            onSelectSlot={(slot) => {
              if (calView === "month") {
                pickCalDate(slot.start);
                pickCalView("day");
              }
            }}
            selectable
            components={calComponents}
            // 7am–9pm is 14 hour-rows at 48px = 672px of grid, plus the
            // header and all-day strip. At 680 the body scrolled while the
            // header didn't, so the header ended up wider than the columns
            // beneath it by exactly one scrollbar — which is the
            // misalignment. Tall enough to fit means nothing scrolls and
            // nothing can drift.
            style={{
              // Month needs six rows of chips; Day and Week only ever show
              // hours here, and on a phone those two are lists anyway.
              height: isNarrow ? 720 : 780,
            }}
          />
          )}
        </div>
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