import { supabase } from "../supabaseClient";

// Two time windows overlap if each starts before the other ends.
export function windowsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Fetch existing scheduled/completed jobs for a set of techs on a given day,
// excluding an optional job id (when editing). Returns jobs with their techs.
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
      id, starts_at, duration_hours, status,
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

// Given a proposed job window + assigned techs, and the day's existing jobs,
// return a list of conflicts: { techName, jobName, start, end }.
export function findConflicts(proposedStart, proposedEnd, techIds, existingJobs) {
  const conflicts = [];
  for (const job of existingJobs) {
    if (!job.starts_at) continue;
    const jStart = new Date(job.starts_at);
    const jEnd = new Date(jStart.getTime() + (job.duration_hours || 3) * 3600000);
    if (!windowsOverlap(proposedStart, proposedEnd, jStart, jEnd)) continue;

    const clashingTechs = (job.assignments || []).filter(
      (a) => a.tech?.id && techIds.includes(a.tech.id)
    );

    for (const a of clashingTechs) {
      conflicts.push({
        techName: a.tech.full_name,
        jobName: job.lead?.name || job.customer?.name || "another job",
        start: jStart,
        end: jEnd,
      });
    }
  }
  return conflicts;
}