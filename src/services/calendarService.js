import { supabase } from "../supabaseClient";

// Update just the timing of a job (date/time via starts_at, plus duration).
export async function updateJobTiming(jobId, { starts_at, duration_hours }) {
  const { error } = await supabase
    .from("jobs")
    .update({ starts_at, duration_hours })
    .eq("id", jobId);
  if (error) throw error;
}

// Jobs (scheduled + completed) with a start time, for the calendar.
//
// `onlyTechId` narrows it to one person's work. Owners pass nothing and see
// the whole team, which is the point of the calendar for them — who is where
// tomorrow. Crew pass their own id, because the rest of the team's addresses
// and prices are not theirs to browse.
//
// Filtered by a separate lookup rather than a nested filter on the embedded
// job_assignments: PostgREST would still return every job and merely empty
// the assignments array on the ones that don't match, which reads as "the
// whole calendar, with the names stripped off" — the opposite of the
// intent. Same two-step conflictService already uses.
export async function fetchCalendarJobs(onlyTechId = null) {
  let jobIds = null;

  if (onlyTechId) {
    const { data: mine, error: mineErr } = await supabase
      .from("job_assignments")
      .select("job_id")
      .eq("tech_id", onlyTechId);
    if (mineErr) throw mineErr;

    jobIds = mine.map((r) => r.job_id);
    // Assigned to nothing. Return early rather than issuing `.in("id", [])`,
    // which some PostgREST versions treat as no filter at all — and the
    // failure mode there is showing a tech every job in the business.
    if (jobIds.length === 0) return [];
  }

  let query = supabase
    .from("jobs")
    .select(`
      id, starts_at, duration_hours, status, price, final_price, notes,
      lead:lead_id ( name, address, phone ),
      customer:customer_id ( name, address ),
      assignments:job_assignments ( tech:tech_id ( full_name ) )
    `)
    .in("status", ["scheduled", "completed"])
    .not("starts_at", "is", null);

  if (jobIds) query = query.in("id", jobIds);

  const { data, error } = await query.order("starts_at", { ascending: true });

  if (error) throw error;
  return data;
}