import { supabase } from "../supabaseClient";

// Booked leads that still need to be turned into scheduled jobs.
export async function fetchBookedLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("status", "booked")
    .order("appointment_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}

// All active techs + admins (anyone who can be assigned to a job).
export async function fetchTechs() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("active", true)
    .order("full_name");

  if (error) throw error;
  return data;
}

// Create a scheduled job from a booked lead, assign techs, flip the lead
// to 'scheduled' so it leaves the Leads board.
export async function scheduleJob({ lead, startsAt, durationHours, techIds }) {
  // 1. Create the job row.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      lead_id: lead.id,
      customer_id: lead.customer_id ?? null,
      services: lead.interior ? "Interior + exterior windows" : "Exterior windows",
      price: lead.estimate,
      starts_at: startsAt,
      duration_hours: durationHours,
      status: "scheduled",
    })
    .select()
    .single();

  if (jobErr) throw jobErr;

  // 2. Create assignment rows (one per tech).
  if (techIds.length > 0) {
    const rows = techIds.map((tech_id) => ({ job_id: job.id, tech_id }));
    const { error: assignErr } = await supabase
      .from("job_assignments")
      .insert(rows);
    if (assignErr) throw assignErr;
  }

  // 3. Flip the lead to 'scheduled' (removes it from the Leads board).
  const { error: leadErr } = await supabase
    .from("leads")
    .update({ status: "scheduled" })
    .eq("id", lead.id);
  if (leadErr) throw leadErr;

  return job;
}

// All scheduled jobs, with their lead info and assigned techs joined in.
export async function fetchScheduledJobs() {
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      *,
      lead:lead_id ( name, address, phone, email, interior ),
      assignments:job_assignments ( tech:tech_id ( id, full_name ) )
    `)
    .eq("status", "scheduled")
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}