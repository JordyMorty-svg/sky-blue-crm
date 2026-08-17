import { supabase } from "../supabaseClient";

// Strip a phone number to digits only, for reliable matching.
function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}

// Find an existing customer by normalized phone, or create one.
async function findOrCreateCustomerFromRow(row) {
  const norm = normalizePhone(row.phone);

  if (norm) {
    const { data: candidates, error } = await supabase
      .from("customers")
      .select("id, phone");
    if (error) throw error;
    const match = (candidates || []).find(
      (c) => normalizePhone(c.phone) === norm
    );
    if (match) return match.id;
  }

  const { data: created, error: createErr } = await supabase
    .from("customers")
    .insert({
      name: row.name,
      phone: row.phone || null,
      address: row.address || null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      notes: row.notes || null,
    })
    .select("id")
    .single();
  if (createErr) throw createErr;
  return created.id;
}

// Bulk-create historical completed jobs (customer + completed job each,
// no lead). Rows: { name, phone, address, date, amount, method, interior }.
// Returns the number created.
export async function addPastJobs(rows) {
  let created = 0;
  for (const row of rows) {
    const customerId = await findOrCreateCustomerFromRow(row);

    const startsAt = row.date
      ? new Date(`${row.date}T${row.time || "09:00"}`).toISOString()
      : null;

    const { error } = await supabase.from("jobs").insert({
      customer_id: customerId,
      services: row.interior ? "Interior + exterior windows" : "Exterior windows",
      price: Number(row.amount) || 0,
      final_price: Number(row.amount) || 0,
      starts_at: startsAt,
      status: "completed",
      paid: true,
      payment_method: row.method || null,
    });
    if (error) throw error;
    created += 1;
  }
  return created;
}

// All customers, newest first.
export async function fetchCustomers() {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}

// A single customer with all their jobs (their history) and any notes
// from the leads those jobs came from.
export async function fetchCustomer(id) {
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("*")
    .eq("id", id)
    .single();
  if (custErr) throw custErr;

  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("*, lead:lead_id ( id, notes, created_at ), assignments:job_assignments ( tech:tech_id ( full_name ) )")
    .eq("customer_id", id)
    .order("starts_at", { ascending: false, nullsFirst: false });
  if (jobsErr) throw jobsErr;

  // Collect non-empty notes from the leads behind these jobs (deduped).
  const seen = new Set();
  const leadNotes = [];
  for (const job of jobs) {
    const lead = job.lead;
    if (lead && lead.notes && lead.notes.trim() && !seen.has(lead.id)) {
      seen.add(lead.id);
      leadNotes.push({ id: lead.id, notes: lead.notes, created_at: lead.created_at });
    }
  }

  return { customer, jobs, leadNotes };
}

// Update a customer's editable fields.
export async function updateCustomer(id, changes) {
  const { error } = await supabase.from("customers").update(changes).eq("id", id);
  if (error) throw error;
}

// Delete a customer.
//
// Refuses by default when they have jobs, because those carry final_price
// and square_payment_id that the Income page reports from — the same guard
// the leads page uses. `force` removes the jobs too, which is what clearing
// test data actually needs.
//
// Order follows the foreign keys: job_assignments -> jobs -> customer.
// Returns { deleted, jobCount } so the caller can explain what happened.
export async function deleteCustomer(id, { force = false } = {}) {
  const { data: jobs, error: jobErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("customer_id", id);
  if (jobErr) throw jobErr;

  const jobCount = jobs?.length || 0;
  if (jobCount > 0 && !force) {
    return { deleted: false, jobCount };
  }

  if (jobCount > 0) {
    const jobIds = jobs.map((j) => j.id);

    const { error: assignErr } = await supabase
      .from("job_assignments")
      .delete()
      .in("job_id", jobIds);
    if (assignErr) throw assignErr;

    const { error: delJobsErr } = await supabase
      .from("jobs")
      .delete()
      .in("id", jobIds);
    if (delJobsErr) throw delJobsErr;
  }

  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) throw error;

  return { deleted: true, jobCount };
}

// Completed jobs with payment info, for income reporting.
export async function fetchCompletedJobs() {
  const { data, error } = await supabase
    .from("jobs")
    .select("*, lead:lead_id ( name )")
    .eq("status", "completed")
    .order("starts_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data;
}