import { useEffect, useMemo, useState } from "react";
import {
  fetchJobsForTechsOnDay,
  findConflicts,
} from "../../services/conflictService";
import { FALLBACK_HOURS, describeGap, travelGap } from "../../services/durationService";
import { fetchDriveMinutes } from "../../services/driveTimeService";
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

function minutesPct(minutes) {
  return (minutes / (HOURS * 60)) * 100;
}

function fmt(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Shows a compact day timeline of existing jobs for the selected techs on the
 * selected day, previews the proposed job in place, and reports conflicts.
 *
 * ---------------------------------------------------------------------------
 * THE TRAVEL STRIP
 * ---------------------------------------------------------------------------
 *
 * Each existing job now carries a hatched strip after it showing the time the
 * crew needs to get to the next one. It is drawn rather than merely enforced
 * because the complaint that started all of this — jobs booked too close
 * together — was never that the rule was unknown. It was that an empty gap on
 * a calendar looks like free time. A gap you can see is a gap nobody fills.
 *
 * Props:
 *   day        — Date of the selected appointment day
 *   time       — "HH:mm" of the proposed start
 *   duration   — hours (number)
 *   techIds    — array of selected tech ids
 *   place      — {latitude, longitude} of the proposed job, when known
 *   excludeJobId — optional job id to ignore (when editing)
 *   onConflictChange — (conflicts[]) => void   (optional)
 */
export default function DayPreview({
  day,
  time,
  duration,
  techIds,
  place = null,
  excludeJobId = null,
  onConflictChange,
}) {
  const [existing, setExisting] = useState([]);
  const [loading, setLoading] = useState(false);
  // Routed minutes by existing job id. Empty is the normal, working state:
  // every consumer of this falls back to straight-line distance.
  const [driven, setDriven] = useState(() => new Map());

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

  // Ask for real drive times once the day's jobs and the proposed address are
  // both known. Keyed on the ids and the rounded coordinates, so moving the
  // time slider does not re-ask and neither does typing in the price field.
  const placeKey = place
    ? `${Math.round(place.latitude * 1e4)},${Math.round(place.longitude * 1e4)}`
    : "";
  const jobsKey = existing.map((j) => j.id).join(",");

  useEffect(() => {
    let cancelled = false;
    if (!place || existing.length === 0) return undefined;
    const withCoords = existing.filter(
      (j) => Number.isFinite(Number(j.latitude)) && Number.isFinite(Number(j.longitude))
    );
    if (withCoords.length === 0) return undefined;

    fetchDriveMinutes(withCoords.map((j) => [j, place])).then((minutes) => {
      if (cancelled) return;
      const next = new Map();
      withCoords.forEach((j, i) => {
        if (minutes[i] !== null) next.set(j.id, minutes[i]);
      });
      setDriven(next);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsKey, placeKey]);

  // Proposed window.
  let proposedStart = null;
  let proposedEnd = null;
  if (day && time) {
    const [h, m] = time.split(":").map(Number);
    proposedStart = new Date(day);
    proposedStart.setHours(h, m, 0, 0);
    proposedEnd = new Date(
      proposedStart.getTime() + (duration || FALLBACK_HOURS) * 3600000
    );
  }

  // Conflicts.
  const conflicts =
    proposedStart && proposedEnd
      ? findConflicts(proposedStart, proposedEnd, techIds || [], existing, {
          proposedPlace: place,
          drivenMinutes: driven,
        })
      : [];

  useEffect(() => {
    onConflictChange?.(conflicts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.length, proposedStart?.getTime(), proposedEnd?.getTime()]);

  // The gap each existing job needs before the crew could be at the new one.
  const gaps = useMemo(() => {
    const out = new Map();
    for (const job of existing) {
      out.set(job.id, travelGap(job, place, driven.get(job.id) ?? null));
    }
    return out;
  }, [existing, place, driven]);

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
                {/* Two different mistakes, two different sentences. "No time
                    to get there" is actionable — move it half an hour —
                    while "already has" reads as a flat refusal. */}
                {c.travel ? (
                  <>
                    <strong>{c.techName}</strong> can&apos;t get there in time —{" "}
                    {c.jobName} runs to {fmt(c.end)} and that is a{" "}
                    {describeGap(c.gap)}
                  </>
                ) : (
                  <>
                    <strong>{c.techName}</strong> already has {c.jobName} (
                    {fmt(c.start)}–{fmt(c.end)})
                  </>
                )}
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

        {/* Existing jobs, each with the road that follows it */}
        {existing.map((job) => {
          const s = new Date(job.starts_at);
          const hours = job.duration_hours || FALLBACK_HOURS;
          const e = new Date(s.getTime() + hours * 3600000);
          const who = job.lead?.name || job.customer?.name || "Job";
          const gap = gaps.get(job.id);
          return (
            <div key={job.id}>
              <div
                className={`daypreview__job daypreview__job--${job.status}`}
                style={{
                  top: `${topPct(s)}%`,
                  height: `${heightPct(s, hours)}%`,
                }}
                title={`${who} · ${fmt(s)}`}
              >
                <span className="daypreview__jobname">{who}</span>
                <span className="daypreview__jobtime">{fmt(s)}</span>
              </div>
              {gap && (
                <div
                  className="daypreview__travel"
                  style={{
                    top: `${topPct(e)}%`,
                    height: `${minutesPct(gap.minutes)}%`,
                  }}
                  title={`Travel from ${who} — ${describeGap(gap)}`}
                >
                  <span className="daypreview__travellabel">{gap.minutes}m</span>
                </div>
              )}
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
              height: `${heightPct(proposedStart, duration || FALLBACK_HOURS)}%`,
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
