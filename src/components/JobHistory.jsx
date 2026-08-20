import { useEffect, useState } from "react";
import { fetchJobEvents } from "../services/jobService";
import { planFor } from "../services/leadService";
import { paymentLabel, money, formatStamp } from "./jobFormat";
import "./JobHistory.css";

/**
 * Everything that has happened to a job, oldest first.
 *
 * Shown on the record page for a finished job and on the edit page for one
 * that hasn't happened yet. Deliberately the same component in both places:
 * a job's story doesn't change shape when it gets completed, it just gets
 * longer. Nothing has to be hidden for a scheduled job either — it simply
 * has no completion or payment row written yet.
 *
 * The component fetches its own events and fails quietly. If
 * db/job-events.sql hasn't been run, or job_events isn't readable, the
 * section doesn't appear rather than taking down the page it sits on —
 * which matters most on the edit page, where the rest of the form is how
 * work actually gets scheduled.
 */

// One line per kind of thing that can happen to a job.
//
// The wording is deliberately past tense and specific — "Payment taken",
// not "Payment" — because this is a record of things that happened, and
// each line should read as a sentence on its own.
const EVENT_LABELS = {
  created: "Added to the CRM",
  scheduled: "Booked",
  rescheduled: "Rescheduled",
  plan: "Plan changed",
  property: "Property type changed",
  price: "Quote updated",
  completed: "Job submitted",
  payment: "Payment taken",
  invoice: "Invoice sent",
  cancelled: "Cancelled",
  status: "Status changed",
};

// The spine of the job: booked, done, paid — plus going onto a plan, which
// is a sale rather than logistics and is usually the most interesting thing
// that happened on the visit. These always show.
//
// Everything else — reschedules, re-quotes, a property-type correction — is
// a change along the way. Real history, and worth keeping, but it shouldn't
// be the first thing the eye lands on.
const MILESTONE_KINDS = new Set([
  "created",
  "scheduled",
  "plan",
  "completed",
  "payment",
  "invoice",
  "cancelled",
]);

// Below this the whole list fits on a phone screen and hiding anything is
// just an extra tap. Above it, the milestones start getting buried.
const COLLAPSE_ABOVE = 6;

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// job_events reuses from_status/to_status as a generic before/after pair,
// so the label depends on the kind. Plans are named here rather than in the
// database so SERVICE_PLANS stays the single source of truth for wording.
function eventTitle(ev) {
  const base = EVENT_LABELS[ev.kind] || ev.kind;

  if (ev.kind === "plan" && ev.to_status) {
    return `${planFor(ev.from_status).label} → ${planFor(ev.to_status).label}`;
  }
  if (ev.kind === "property" && ev.to_status) {
    return `${titleCase(ev.from_status)} → ${titleCase(ev.to_status)}`;
  }
  if (ev.kind === "status" && ev.from_status && ev.to_status) {
    return `${base}: ${ev.from_status} → ${ev.to_status}`;
  }
  return base;
}

// The second line of a history row: the money, the method, and any note.
//
// Except on the completion row, which carries neither. What was charged and
// how it was paid are already spelled out above the timeline, and repeating
// "$450 · Cash" two lines later doesn't add a fact — it just gives the eye
// more to wade through. What that row is FOR is the moment it was submitted.
//
// A backfilled note still shows, because "time not known" is a caveat about
// the timestamp itself and has to travel with it.
function eventMeta(ev) {
  const parts = [];

  if (ev.kind !== "completed") {
    if (ev.amount != null) parts.push(money(ev.amount));
    if (ev.payment_method) parts.push(paymentLabel(ev.payment_method));
  }
  if (ev.detail) parts.push(ev.detail);

  return parts.join(" · ");
}

export default function JobHistory({
  jobId,
  refreshKey = 0,
  title = "History",
  // Lets the host page put a card around the timeline without wrapping it
  // in an extra div — which would still be there, empty and bordered, on a
  // job that has no events yet.
  className = "",
}) {
  const [events, setEvents] = useState([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!jobId) return undefined;

    // Guarded so a fetch that lands after the user has navigated away
    // doesn't set state on an unmounted component.
    let cancelled = false;

    // Started inside the effect rather than called directly, so the state
    // update lands after the await instead of synchronously during the
    // effect (react-hooks/set-state-in-effect).
    void (async () => {
      try {
        const rows = await fetchJobEvents(jobId);
        if (!cancelled) setEvents(rows || []);
      } catch (e) {
        // Almost always "the migration hasn't been run yet". Logged for the
        // console, silent on screen.
        console.error(e);
        if (!cancelled) setEvents([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, refreshKey]);

  if (events.length === 0) return null;

  // A busy job can pick up half a dozen reschedules and a plan switch, and
  // if they all render at full weight the milestones end up buried. So the
  // changes stay in the log and stay visible, but they fold away once the
  // list is long.
  const milestones = events.filter((ev) => MILESTONE_KINDS.has(ev.kind));
  const changeCount = events.length - milestones.length;
  const canCollapse = events.length > COLLAPSE_ABOVE && changeCount > 0;
  const shown = canCollapse && !showAll ? milestones : events;

  return (
    <section className={className ? `jobhist ${className}` : "jobhist"}>
      <h2 className="jobhist__head">{title}</h2>

      <ol className="jobhist__timeline">
        {shown.map((ev) => (
          <li
            className={
              `jobhist__event jobhist__event--${ev.kind}` +
              (MILESTONE_KINDS.has(ev.kind) ? "" : " jobhist__event--minor")
            }
            key={ev.id}
          >
            <span className="jobhist__dot" />
            <div className="jobhist__body">
              <span className="jobhist__title">{eventTitle(ev)}</span>
              {eventMeta(ev) && (
                <span className="jobhist__meta">{eventMeta(ev)}</span>
              )}
            </div>
            <div className="jobhist__when">
              <span>{formatStamp(ev.created_at)}</span>
              {ev.actor?.full_name && (
                <span className="jobhist__actor">{ev.actor.full_name}</span>
              )}
            </div>
          </li>
        ))}
      </ol>

      {canCollapse && (
        <button
          type="button"
          className="jobhist__more"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? "Hide changes"
            : `Show ${changeCount} more ${
                changeCount === 1 ? "change" : "changes"
              }`}
        </button>
      )}
    </section>
  );
}
