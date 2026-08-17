import { supabase } from "../supabaseClient";
import { nextVisitDate, priceForVisit } from "./leadService";

// How far ahead of its due date a recurring visit becomes schedulable.
// Before this it sits as "upcoming" — visible on the customer, absent from
// the working schedule, so the Jobs board isn't cluttered with work three
// months away. Crews get assigned close to the date, when the roster is
// actually known.
export const RECURRING_LEAD_TIME_DAYS = 14;

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
      // The plan governs future visits, so it belongs on the customer too.
      service_plan: lead.service_plan || "one_time",
      property_type: lead.property_type || "residential",
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
      service_plan: lead.service_plan || "one_time",
      property_type: lead.property_type || "residential",
      // Scheduling from a lead is always the customer's first visit on
      // this plan. Follow-ups are created by completeJob and count up.
      visit_number: 1,
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
      customer:customer_id ( id, name, address, phone, email ),
      assignments:job_assignments ( tech:tech_id ( id, full_name ) )
    `)
    .eq("status", "scheduled")
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}

// A single job with lead + customer + assigned tech ids, for the edit page.
// The customer join carries the Square ids, so the complete-job screen can
// offer a repeat customer's card on file without another round trip.
export async function fetchJob(id) {
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      *,
      lead:lead_id ( name, address, phone, email, interior ),
      customer:customer_id (
        id, name, address, phone, email,
        service_plan, property_type,
        square_customer_id, square_card_id,
        card_brand, card_last4, card_exp_month, card_exp_year
      ),
      assignments:job_assignments ( tech_id )
    `)
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

// Permanently delete a job — used when one was booked by mistake or
// replaced. Assignments go first because they reference the job; any
// follow-up visit pointing at this one via previous_job_id is left alone,
// since that column is ON DELETE SET NULL.
export async function deleteJob(jobId) {
  const { error: assignErr } = await supabase
    .from("job_assignments")
    .delete()
    .eq("job_id", jobId);
  if (assignErr) throw assignErr;

  const { error } = await supabase.from("jobs").delete().eq("id", jobId);
  if (error) throw error;
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
      customer:customer_id ( id, name, address, phone, email ),
      assignments:job_assignments ( tech:tech_id ( id, full_name ) )
    `)
    .in("id", jobIds)
    .eq("status", status)
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data;
}

// Create the follow-up job for a recurring plan.
//
// Returns the new job, or null when there's nothing to schedule. Called
// after a job completes; a failure here must never undo the completion,
// so the caller treats it as best-effort.
export async function createNextVisit(job) {
  if (!job.customer_id) return null; // nothing to attach recurrence to

  // The customer record is the source of truth for what plan they're on
  // NOW. The job carries the plan it was created under, which goes stale
  // the moment someone is moved onto a plan after their job was booked —
  // exactly what happens when a one-off customer signs up for quarterly.
  // Falling back to the job's own values keeps older rows working.
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("service_plan, property_type")
    .eq("id", job.customer_id)
    .single();
  if (custErr) throw custErr;

  const plan = customer?.service_plan || job.service_plan || "one_time";
  const propertyType =
    customer?.property_type || job.property_type || "residential";

  const startsAt = nextVisitDate(job.starts_at, plan);
  if (!startsAt) return null; // one-time — no next visit

  const visitNumber = (job.visit_number || 1) + 1;
  const price = priceForVisit(job.price, plan, visitNumber, propertyType);

  // Don't double-book: if a later visit already exists for this customer,
  // completing an older job again shouldn't spawn a duplicate.
  const { data: existing, error: existErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("customer_id", job.customer_id)
    .gte("visit_number", visitNumber)
    .limit(1);
  if (existErr) throw existErr;
  if (existing?.length) return null;

  const { data: next, error } = await supabase
    .from("jobs")
    .insert({
      lead_id: job.lead_id,
      customer_id: job.customer_id,
      services: job.services,
      price,
      starts_at: startsAt,
      duration_hours: job.duration_hours,
      // Not "scheduled": it's due, not booked. It surfaces for crew
      // assignment RECURRING_LEAD_TIME_DAYS before this date.
      status: "upcoming",
      service_plan: plan,
      property_type: propertyType,
      visit_number: visitNumber,
      previous_job_id: job.id,
    })
    .select()
    .single();
  if (error) throw error;

  // Deliberately no crew copied. Who works a job three months out isn't
  // knowable now, and a stale assignment is worse than none.
  return next;
}

// Recurring visits close enough to their due date to be worth scheduling.
export async function fetchDueVisits() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + RECURRING_LEAD_TIME_DAYS);

  const { data, error } = await supabase
    .from("jobs")
    .select(`
      *,
      customer:customer_id ( id, name, address, phone, email ),
      lead:lead_id ( name, address, phone, email, interior )
    `)
    .eq("status", "upcoming")
    .lte("starts_at", cutoff.toISOString())
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

// The soonest visit a customer has due, whether or not it's schedulable yet.
export async function fetchNextVisit(customerId) {
  if (!customerId) return null;
  const { data, error } = await supabase
    .from("jobs")
    .select("id, starts_at, price, visit_number, service_plan")
    .eq("customer_id", customerId)
    .eq("status", "upcoming")
    .order("starts_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

// Turn a due visit into a real scheduled job: confirm the time, duration
// and crew. This is the moment it joins the working schedule.
export async function confirmVisit(jobId, { startsAt, durationHours, techIds, notes }) {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "scheduled",
      starts_at: startsAt,
      duration_hours: durationHours,
      notes: notes || null,
    })
    .eq("id", jobId);
  if (error) throw error;

  if (techIds?.length) {
    const { error: assignErr } = await supabase
      .from("job_assignments")
      .insert(techIds.map((tech_id) => ({ job_id: jobId, tech_id })));
    if (assignErr) throw assignErr;
  }
}

// Book a job straight onto an existing customer, with no lead behind it —
// the "schedule another visit" path from the customer profile.
export async function scheduleJobForCustomer({
  customer,
  startsAt,
  durationHours,
  techIds,
  notes,
  price,
  services,
  servicePlan,
  propertyType,
}) {
  // Continue the customer's visit count rather than restarting at 1, so
  // plan discounts keep applying correctly.
  const { data: prior, error: priorErr } = await supabase
    .from("jobs")
    .select("visit_number")
    .eq("customer_id", customer.id)
    .order("visit_number", { ascending: false })
    .limit(1);
  if (priorErr) throw priorErr;

  const visitNumber = (prior?.[0]?.visit_number || 0) + 1;

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: customer.id,
      services: services || "Exterior windows",
      price: Number(price) || 0,
      starts_at: startsAt,
      duration_hours: durationHours,
      notes: notes || null,
      status: "scheduled",
      service_plan: servicePlan || customer.service_plan || "one_time",
      property_type: propertyType || customer.property_type || "residential",
      visit_number: visitNumber,
    })
    .select()
    .single();
  if (error) throw error;

  if (techIds?.length) {
    const { error: assignErr } = await supabase
      .from("job_assignments")
      .insert(techIds.map((tech_id) => ({ job_id: job.id, tech_id })));
    if (assignErr) throw assignErr;
  }

  return job;
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

  // Book the next visit for recurring plans. Deliberately last and
  // deliberately swallowed: the job is already completed and paid, and a
  // failure to schedule three months out must not roll that back or show
  // an error to someone standing on a doorstep.
  let nextVisit = null;
  try {
    nextVisit = await createNextVisit(job);
  } catch (e) {
    console.error("Couldn't schedule the next visit:", e);
  }
  return { nextVisit };
}