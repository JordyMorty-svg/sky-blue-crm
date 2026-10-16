import { useEffect, useMemo, useState } from "react";
import {
  fetchJobsForTechsOnDay,
  findConflicts,
} from "../../services/conflictService";
import {
  FALLBACK_HOURS,
  describeGap,
  gapLabel,
  planGaps,
} from "../../services/durationService";
import { fetchDriveMinutes } from "../../services/driveTimeService";
import { jobAddress } from "../../services/jobAddress";
import "./DayPreview.css";

// Timeline window: 7 AM to 9 PM.
const START_HOUR = 7;
const END_HOUR = 21;
const HOURS = END_HOUR - START_HOUR;

// The id the job being booked goes by in the day's timeline.
const PROPOSED = "__proposed__";

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

  // Proposed window. Computed before the effects below, because the travel
  // strips treat the job being booked as one more stop on the day.
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

  // Primitives, because the hook linter will not take `x?.getTime()` in a
  // dependency list — and two Dates are never === each other anyway, so the
  // milliseconds are what the memo actually wants to compare.
  const startMs = proposedStart ? proposedStart.getTime() : null;
  const endMs = proposedEnd ? proposedEnd.getTime() : null;

  // Routed minutes, keyed "fromId>toId". Empty is the normal, working state:
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

  // Every stop on the day, the proposed job included, in time order. This is
  // the list the travel strips are derived from — see planGaps().
  const stops = useMemo(() => {
    const list = existing.map((j) => {
      const start = new Date(j.starts_at);
      const hours = j.duration_hours || FALLBACK_HOURS;
      return {
        id: j.id,
        start,
        end: new Date(start.getTime() + hours * 3600000),
        // The ladder, not the row: a scheduled job has no address of its
        // own until the freeze trigger runs at completion.
        place: jobAddress(j),
        label: j.lead?.name || j.customer?.name || "Job",
      };
    });
    if (proposedStart && proposedEnd) {
      list.push({
        id: PROPOSED,
        start: proposedStart,
        end: proposedEnd,
        place,
        label: "the new job",
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, startMs, endMs, place]);

  // Ask for real drive times for the pairs that are actually consecutive.
  // Keyed on the pair ids, so nudging the start time only re-asks when it
  // changes who follows whom — not on every keystroke in the price field.
  const pairs = useMemo(
    () => planGaps(stops).map((g) => [g.fromId, g.toId]),
    [stops]
  );
  const pairsKey = pairs.map((p) => p.join(">")).join("|");

  useEffect(() => {
    let cancelled = false;
    const byId = new Map(stops.map((s) => [s.id, s]));
    const wanted = pairs.filter(([a, b]) => byId.get(a)?.place && byId.get(b)?.place);
    if (wanted.length === 0) return undefined;

    fetchDriveMinutes(
      wanted.map(([a, b]) => [byId.get(a).place, byId.get(b).place])
    ).then((minutes) => {
      if (cancelled) return;
      const next = new Map();
      wanted.forEach(([a, b], i) => {
        if (minutes[i] !== null) next.set(`${a}>${b}`, minutes[i]);
      });
      setDriven(next);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairsKey]);

  // Conflicts.
  const conflicts =
    proposedStart && proposedEnd
      ? findConflicts(proposedStart, proposedEnd, techIds || [], existing, {
          proposedPlace: place,
          // Either direction of the pair answers "how far apart are these
          // two", and which one was fetched depends on which job comes first
          // in the day.
          drivenMinutes: new Map(
            existing.map((j) => [
              j.id,
              driven.get(`${j.id}>${PROPOSED}`) ??
                driven.get(`${PROPOSED}>${j.id}`) ??
                null,
            ])
          ),
        })
      : [];

  useEffect(() => {
    onConflictChange?.(conflicts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.length, proposedStart?.getTime(), proposedEnd?.getTime()]);

  // One strip per consecutive pair, derived from the timeline rather than
  // from whichever job is under the cursor. See planGaps() for why that
  // distinction cost an hour.
  const byId = useMemo(() => new Map(stops.map((x) => [x.id, x])), [stops]);
  const gaps = useMemo(
    () => planGaps(stops, (a, b) => driven.get(`${a}>${b}`) ?? null),
    [stops, driven]
  );

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

        {/* Existing jobs */}
        {existing.map((job) => {
          const s = new Date(job.starts_at);
          const hours = job.duration_hours || FALLBACK_HOURS;
          const who = job.lead?.name || job.customer?.name || "Job";
          return (
            <div
              key={job.id}
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
          );
        })}

        {/* The road between each job and the next one. Drawn from the day's
            timeline, so the strip under a block is always the drive to
            whatever genuinely follows it. */}
        {gaps.map((g) => (
          <div
            key={`${g.fromId}>${g.toId}`}
            className={`daypreview__travel ${
              g.tight ? "daypreview__travel--tight" : ""
            }`}
            style={{
              top: `${topPct(g.at)}%`,
              height: `${minutesPct(g.gap.minutes)}%`,
            }}
            title={
              `${byId.get(g.fromId)?.label} → ${byId.get(g.toId)?.label}: ` +
              `${describeGap(g.gap)}${g.tight ? " — not enough time" : ""}`
            }
          >
            <span className="daypreview__travellabel">{gapLabel(g.gap)}</span>
          </div>
        ))}

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
