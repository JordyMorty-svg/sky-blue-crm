import { supabase } from "../supabaseClient";
import { FALLBACK_HOURS, travelGap } from "./durationService";

// Two time windows overlap if each starts before the other ends.
export function windowsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Fetch existing scheduled/completed jobs for a set of techs on a given day,
// excluding an optional job id (when editing). Returns jobs with their techs.
//
// latitude/longitude ride along (db/properties.sql put them on jobs) because
// the gap between two jobs depends on how far apart they are. A job with no
// coordinates still works — it falls back to the local minimum and says so.
export async function fetchJobsForTechsOnDay(techIds, day, excludeJobId = null) {
  if (!techIds || techIds.length === 0 || !day) return [];

  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  // Jobs assigned to any of these techs.
  const { data: assigns, error: aErr } = await supabase
    .from("job_assignments")
    .select("job_id, tech_id")
    .in("tech_id", techIds);
  if (aErr) throw aErr;

  const jobIds = [...new Set(assigns.map((a) => a.job_id))];
  if (jobIds.length === 0) return [];

  const { data: jobs, error: jErr } = await supabase
    .from("jobs")
    .select(`
      id, starts_at, duration_hours, status, latitude, longitude,
      lead:lead_id ( name ),
      customer:customer_id ( name ),
      assignments:job_assignments ( tech:tech_id ( id, full_name ) )
    `)
    .in("id", jobIds)
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString())
    .in("status", ["scheduled", "completed"]);
  if (jErr) throw jErr;

  return (jobs || []).filter((j) => j.id !== excludeJobId);
}

/**
 * Conflicts for a proposed job window.
 *
 * ---------------------------------------------------------------------------
 * TWO JOBS THAT MERELY TOUCH ARE A CONFLICT
 * ---------------------------------------------------------------------------
 *
 * Until 14 October this asked a single question: do the two blocks overlap.
 * By that test, finishing at 1:00 and starting the next job at 1:00 was a
 * clean day — and on 13 October a customer stood on his porch waiting,
 * because nobody can be in two places at once and a van cannot teleport
 * across Corvallis.
 *
 * So the proposed job is now compared against each existing job *widened by
 * the travel gap between them* — 15 minutes locally, more when the routed
 * drive is longer, 30 when the straight-line distance says it is another
 * town. The gap belongs here rather than inside the job's duration: padding
 * every block by 15 minutes would inflate `completed_at - starts_at`, and
 * that measurement is what the duration rule is calibrated from. Pad the
 * jobs and the next recalibration quietly learns that every job takes a
 * quarter of an hour longer than it does.
 *
 * `conflict.travel` is set when the blocks themselves do NOT overlap and only
 * the gap is violated, so the screen can say "no time to get there" rather
 * than "double-booked" — two different mistakes that want two different
 * sentences.
 *
 * @param {Date} proposedStart
 * @param {Date} proposedEnd
 * @param {string[]} techIds
 * @param {object[]} existingJobs
 * @param {object} [opts]
 * @param {object} [opts.proposedPlace]  {latitude, longitude} of the new job
 * @param {Map<string, number>} [opts.drivenMinutes]  real routed minutes by
 *   existing job id, when they have been fetched. Absent is normal.
 */
export function findConflicts(
  proposedStart,
  proposedEnd,
  techIds,
  existingJobs,
  { proposedPlace = null, drivenMinutes = null } = {}
) {
  const conflicts = [];
  for (const job of existingJobs) {
    if (!job.starts_at) continue;
    const jStart = new Date(job.starts_at);
    const jEnd = new Date(
      jStart.getTime() + (job.duration_hours || FALLBACK_HOURS) * 3600000
    );

    const gap = travelGap(
      job,
      proposedPlace,
      drivenMinutes ? drivenMinutes.get(job.id) ?? null : null
    );
    const pad = gap.minutes * 60000;

    const hardOverlap = windowsOverlap(proposedStart, proposedEnd, jStart, jEnd);
    // The existing job widened by the gap on both sides: you have to be able
    // to get there, and you have to be able to get away afterwards.
    const tooClose = windowsOverlap(
      proposedStart,
      proposedEnd,
      new Date(jStart.getTime() - pad),
      new Date(jEnd.getTime() + pad)
    );
    if (!tooClose) continue;

    const clashingTechs = (job.assignments || []).filter(
      (a) => a.tech?.id && techIds.includes(a.tech.id)
    );

    for (const a of clashingTechs) {
      conflicts.push({
        techName: a.tech.full_name,
        jobName: job.lead?.name || job.customer?.name || "another job",
        start: jStart,
        end: jEnd,
        // Only the gap was broken, not the blocks themselves.
        travel: !hardOverlap,
        gap,
      });
    }
  }
  return conflicts;
}
