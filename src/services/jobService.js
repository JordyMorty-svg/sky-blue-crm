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

// Strip a phone number down to digits only, for reliable matching.
function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}

// Find an existing customer by phone number, or create a new one from
// the lead's info. Matches on digits-only so "(425) 951-3646" and
// "4259513646" are treated as the same customer. Returns the customer id.
async function findOrCreateCustomer(lead) {
  const norm = normalizePhone(lead.phone);

  if (norm) {
    // Pull candidate customers and compare normalized phones in JS,
    // since the DB stores them in whatever format they were entered.
    const { data: candidates, error: findErr } = await supabase
      .from("customers")
      .select("id, phone");

    if (findErr) throw findErr;
    const match = (candidates || []).find(
      (c) => normalizePhone(c.phone) === norm
    );
    if (match) return match.id; // reuse — don't overwrite existing data
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

// A single job with lead + assigned tech ids, for the edit page.
export async function fetchJob(id) {
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      *,
      lead:lead_id ( name, address, phone, email, interior ),
      assignments:job_assignments ( tech_id )
    `)
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

// Update a job's editable fields.
export async function updateJob(id, changes) {
  const { error } = await supabase.from("jobs").update(changes).eq("id", id);
  if (error) throw error;
}

// Reconcile a job's tech assignments: add newly-selected techs, remove
// de-selected ones. `currentIds` and `nextIds` are arrays of tech ids.
export async function updateJobTechs(jobId, currentIds, nextIds) {
  const toAdd = nextIds.filter((id) => !currentIds.includes(id));
  const toRemove = currentIds.filter((id) => !nextIds.includes(id));

  if (toAdd.length > 0) {
    const rows = toAdd.map((tech_id) => ({ job_id: jobId, tech_id }));
    const { error } = await supabase.from("job_assignments").insert(rows);
    if (error) throw error;
  }

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from("job_assignments")
      .delete()
      .eq("job_id", jobId)
      .in("tech_id", toRemove);
    if (error) throw error;
  }
}

// Jobs the given tech is assigned to (their personal schedule).
// Filters via the job_assignments join, then returns the full job rows.
export async function fetchMyJobs(techId, { status = "scheduled" } = {}) {
  const { data: assigns, error: aErr } = await supabase
    .from("job_assignments")
    .select("job_id")
    .eq("tech_id", techId);

  if (aErr) throw aErr;
  const jobIds = assigns.map((a) => a.job_id);
  if (jobIds.length === 0) return [];

  const { data, error } = await supabase
    .from("jobs")
    .select(`
      *,
      lead:lead_id ( name, address, phone, email, interior ),
      assignments:job_assignments ( tech:tech_id ( id, full_name ) )
    `)
    .in("id", jobIds)
    .eq("status", status)
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}

// Mark a job completed with payment details, and cascade its linked
// lead to 'completed' too.
export async function completeJob(job, { finalPrice, paymentMethod, paymentNotes }) {
  const { error: jobErr } = await supabase
    .from("jobs")
    .update({
      status: "completed",
      final_price: finalPrice,
      paid: true,
      payment_method: paymentMethod,
      notes: paymentNotes ? `${job.notes ? job.notes + " — " : ""}${paymentNotes}` : job.notes,
    })
    .eq("id", job.id);
  if (jobErr) throw jobErr;

  if (job.lead_id) {
    const { error: leadErr } = await supabase
      .from("leads")
      .update({ status: "completed" })
      .eq("id", job.lead_id);
    if (leadErr) throw leadErr;
  }
}