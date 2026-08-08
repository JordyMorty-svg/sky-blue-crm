import { supabase } from "../supabaseClient";

// Fetch a single lead by id (for the scheduling page).
export async function fetchLeadById(id) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

// Find an existing customer by phone number, or create a new one from
// the lead's info. Returns the customer id either way.
async function findOrCreateCustomer(lead) {
  if (lead.phone) {
    const { data: existing, error: findErr } = await supabase
      .from("customers")
      .select("id")
      .eq("phone", lead.phone)
      .maybeSingle();

    if (findErr) throw findErr;
    if (existing) return existing.id; // match — just link, don't overwrite
  }

  // No phone, or no match — create a new customer record.
  const { data: created, error: createErr } = await supabase
    .from("customers")
    .insert({
      name: lead.name,
      phone: lead.phone || null,
      email: lead.email || null,
      address: lead.address || null,
      lead_id: lead.id,
    })
    .select("id")
    .single();

  if (createErr) throw createErr;
  return created.id;
}

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

// Create a scheduled job from a booked lead: find-or-create the customer,
// create the job, assign techs, flip the lead to 'scheduled'.
export async function scheduleJob({ lead, startsAt, durationHours, techIds, notes }) {
  // 1. Find or create the customer (matched by phone number).
  const customerId = await findOrCreateCustomer(lead);

  // 2. Create the job row, linked to both the lead and the customer.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      lead_id: lead.id,
      customer_id: customerId,
      services: lead.interior ? "Interior + exterior windows" : "Exterior windows",
      price: lead.estimate,
      starts_at: startsAt,
      duration_hours: durationHours,
      notes: notes || null,
      status: "scheduled",
    })
    .select()
    .single();

  if (jobErr) throw jobErr;

  // 3. Create assignment rows (one per tech).
  if (techIds.length > 0) {
    const rows = techIds.map((tech_id) => ({ job_id: job.id, tech_id }));
    const { error: assignErr } = await supabase
      .from("job_assignments")
      .insert(rows);
    if (assignErr) throw assignErr;
  }

  // 4. Flip the lead to 'scheduled' (removes it from the Leads board).
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