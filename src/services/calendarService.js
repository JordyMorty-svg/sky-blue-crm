import { supabase } from "../supabaseClient";

// Update just the timing of a job (date/time via starts_at, plus duration).
export async function updateJobTiming(jobId, { starts_at, duration_hours }) {
  const { error } = await supabase
    .from("jobs")
    .update({ starts_at, duration_hours })
    .eq("id", jobId);
  if (error) throw error;
}

// All jobs (scheduled + completed) with a start time, for the calendar.
// Not tech-filtered — shows the whole team's work.
export async function fetchCalendarJobs() {
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      id, starts_at, duration_hours, status, price, final_price, notes,
      lead:lead_id ( name, address, phone ),
      customer:customer_id ( name, address ),
      assignments:job_assignments ( tech:tech_id ( full_name ) )
    `)
    .in("status", ["scheduled", "completed"])
    .not("starts_at", "is", null)
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return data;
}