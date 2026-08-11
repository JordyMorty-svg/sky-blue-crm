import { useEffect, useState } from "react";
import {
  fetchJobsForTechsOnDay,
  findConflicts,
} from "../../services/conflictService";
import "./DayPreview.css";

// Timeline window: 7 AM to 9 PM.
const START_HOUR = 7;
const END_HOUR = 21;
const HOURS = END_HOUR - START_HOUR;

function topPct(date) {
  const mins = (date.getHours() - START_HOUR) * 60 + date.getMinutes();
  return (mins / (HOURS * 60)) * 100;
}

function heightPct(startDate, hours) {
  return ((hours * 60) / (HOURS * 60)) * 100;
}

function fmt(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Shows a compact day timeline of existing jobs for the selected techs on the
 * selected day, previews the proposed job in place, and reports conflicts.
 *
 * Props:
 *   day        — Date of the selected appointment day
 *   time       — "HH:mm" of the proposed start
 *   duration   — hours (number)
 *   techIds    — array of selected tech ids
 *   excludeJobId — optional job id to ignore (when editing)
 *   onConflictChange — (conflicts[]) => void   (optional)
 */
export default function DayPreview({
  day,
  time,
  duration,
  techIds,
  excludeJobId = null,
  onConflictChange,
}) {
  const [existing, setExisting] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!day || !techIds || techIds.length === 0) {
        setExisting([]);
        onConflictChange?.([]);
        return;
      }
      setLoading(true);
      try {
        const jobs = await fetchJobsForTechsOnDay(techIds, day, excludeJobId);
        if (!cancelled) setExisting(jobs);
      } catch (e) {
        console.error(e);
        if (!cancelled) setExisting([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, techIds?.join(","), excludeJobId]);

  // Proposed window.
  let proposedStart = null;
  let proposedEnd = null;
  if (day && time) {
    const [h, m] = time.split(":").map(Number);
    proposedStart = new Date(day);
    proposedStart.setHours(h, m, 0, 0);
    proposedEnd = new Date(proposedStart.getTime() + (duration || 3) * 3600000);
  }

  // Conflicts.
  const conflicts =
    proposedStart && proposedEnd
      ? findConflicts(proposedStart, proposedEnd, techIds || [], existing)
      : [];

  useEffect(() => {
    onConflictChange?.(conflicts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.length, proposedStart?.getTime(), proposedEnd?.getTime()]);

  if (!day || !techIds || techIds.length === 0) {
    return (
      <div className="daypreview daypreview--empty">
        Pick a date and team members to see that day's schedule.
      </div>
    );
  }

  return (
    <div className="daypreview">
      <div className="daypreview__head">
        <span className="daypreview__date">
          {day.toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
        </span>
        {loading && <span className="daypreview__loading">Checking…</span>}
      </div>

      {conflicts.length > 0 && (
        <div className="daypreview__conflict">
          ⚠️ Scheduling conflict:
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>
                <strong>{c.techName}</strong> already has {c.jobName} ({fmt(c.start)}–{fmt(c.end)})
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="daypreview__timeline">
        {/* Hour gridlines */}
        {Array.from({ length: HOURS + 1 }).map((_, i) => {
          const hour = START_HOUR + i;
          const label =
            hour === 12
              ? "12 PM"
              : hour < 12
              ? `${hour} AM`
              : `${hour - 12} PM`;
          return (
            <div
              className="daypreview__hour"
              key={i}
              style={{ top: `${(i / HOURS) * 100}%` }}
            >
              <span className="daypreview__hourlabel">{label}</span>
              <span className="daypreview__hourline" />
            </div>
          );
        })}

        {/* Existing jobs */}
        {existing.map((job) => {
          const s = new Date(job.starts_at);
          const who = job.lead?.name || job.customer?.name || "Job";
          return (
            <div
              key={job.id}
              className={`daypreview__job daypreview__job--${job.status}`}
              style={{
                top: `${topPct(s)}%`,
                height: `${heightPct(s, job.duration_hours || 3)}%`,
              }}
              title={`${who} · ${fmt(s)}`}
            >
              <span className="daypreview__jobname">{who}</span>
              <span className="daypreview__jobtime">{fmt(s)}</span>
            </div>
          );
        })}

        {/* Proposed job preview */}
        {proposedStart && (
          <div
            className={`daypreview__proposed ${
              conflicts.length > 0 ? "daypreview__proposed--conflict" : ""
            }`}
            style={{
              top: `${topPct(proposedStart)}%`,
              height: `${heightPct(proposedStart, duration || 3)}%`,
            }}
          >
            <span className="daypreview__jobname">New job</span>
            <span className="daypreview__jobtime">
              {fmt(proposedStart)}–{fmt(proposedEnd)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}