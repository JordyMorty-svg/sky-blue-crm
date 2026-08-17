import { supabase } from "../supabaseClient";

// Active pipeline stages shown on the Kanban board, in order.
// The terminal statuses below are excluded — a lead in any of them has
// left the pipeline and lives on the All Leads page instead.
export const PIPELINE_STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
];

// Every possible status (used for reference / labels).
//
// The three terminal states mean genuinely different things:
//   completed — the job got done and paid. This is "won".
//   lost      — they said no. An explicit human decision.
//   archived  — it went quiet. Nobody said no, it just stopped moving.
// Lost and archived both leave the board, but you'd re-contact an archived
// lead far sooner than a lost one, so they stay separate.
export const ALL_STATUSES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "lost", label: "Lost" },
  { key: "archived", label: "Archived" },
];

// Statuses a user can MANUALLY set from the Leads page (Move menu + detail
// dropdown). 'new' is website-only; 'scheduled'/'completed' are set from the
// Jobs side; 'lost' and 'archived' are allowed (admin-permission gating
// comes later).
export const LEADS_SETTABLE_STATUSES = [
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
  { key: "lost", label: "Lost" },
  { key: "archived", label: "Archived" },
];

// A lead that hasn't changed status in this long counts as stale.
// Derived at read time from lead_events rather than written into
// leads.status by a timer: a quiet lead stays exactly where you left it,
// and this number can be retuned without a migration once there's real
// data to tune it against.
export const STALE_AFTER_DAYS = 21;

// Which stages allow manually adding a lead (door-knocking).
// 'new' is excluded — those only come from the website quote form.
export const MANUAL_ADD_STAGES = ["contacted", "quoted", "booked"];

// Lead temperature (how interested they seemed), with dot colors.
export const TEMPERATURES = [
  { key: "receptive", label: "Receptive", color: "#16a34a" }, // green
  { key: "hesitant", label: "Hesitant", color: "#f59e0b" },   // amber
  { key: "maybe", label: "Maybe", color: "#94a3b8" },         // gray
];

// Days since each lead last changed status, from the lead_status_age view.
// One flat query, merged client-side — same shape as the job counts.
async function fetchStatusAges() {
  const { data, error } = await supabase
    .from("lead_status_age")
    .select("lead_id, days_since_change");
  if (error) throw error;

  const ages = new Map();
  for (const row of data || []) ages.set(row.lead_id, row.days_since_change);
  return ages;
}

// Only a lead still moving through the pipeline can be stale. A completed,
// lost or archived lead has finished — it isn't neglected.
export function isStale(lead) {
  if (!PIPELINE_STAGES.some((s) => s.key === lead.status)) return false;
  return (lead.daysSinceChange ?? 0) >= STALE_AFTER_DAYS;
}

// Fetch all active leads, newest first, annotated with staleness.
//
// Filtering by an allowlist derived from PIPELINE_STAGES rather than a
// blocklist of terminal statuses: add a terminal status later and this
// keeps working on its own.
export async function fetchActiveLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .in(
      "status",
      PIPELINE_STAGES.map((s) => s.key)
    )
    .order("created_at", { ascending: false });

  if (error) throw error;

  const ages = await fetchStatusAges();
  return (data || []).map((lead) => {
    const daysSinceChange = ages.get(lead.id) ?? null;
    return { ...lead, daysSinceChange, stale: isStale({ ...lead, daysSinceChange }) };
  });
}

// Full status history for one lead, oldest first — the timeline on the
// lead detail page. changed_by references profiles, so the actor's name
// embeds the same way leads.created_by does. It can be null: an edit made
// in the Supabase table editor, or by a user without a profile row.
export async function fetchLeadEvents(leadId) {
  const { data, error } = await supabase
    .from("lead_events")
    .select("id, from_status, to_status, created_at, actor:changed_by ( full_name )")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

// Update a single lead's status.
export async function updateLeadStatus(id, status) {
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", id);

  if (error) throw error;
}

// Update status along with any extra fields (e.g. price when moving to
// quoted, appointment_at when moving to booked). Returns the updated row.
export async function updateLead(id, changes) {
  const { data, error } = await supabase
    .from("leads")
    .update(changes)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Fetch a single lead by id, including who created it.
export async function fetchLead(id) {
  const { data, error } = await supabase
    .from("leads")
    .select("*, creator:created_by ( full_name )")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

// Permanently delete a lead from the database.
export async function deleteLead(id) {
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// All-leads view (the archive / cleanup page)
// ---------------------------------------------------------------------------

// Every lead ever, regardless of status, annotated with what it's attached
// to. Two things decide whether a lead is safe to clean up:
//
//   jobCount  — jobs carry final_price and payment ids that Income reports
//               from, so any lead with jobs is real history, not test data.
//   customer  — scheduling a lead creates a customer row pointing back at it.
//               That row can be shared: findOrCreateCustomer matches on phone,
//               so one customer may serve several leads. It's only safe to
//               remove alongside its lead when it has no jobs of its own and
//               no other lead depends on it.
export async function fetchAllLeads() {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("*, creator:created_by ( full_name )")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const ages = await fetchStatusAges();

  // Three flat queries rather than N per lead — this stays fast as the
  // list grows.
  const [{ data: jobs, error: jobsErr }, { data: customers, error: custErr }] =
    await Promise.all([
      supabase.from("jobs").select("id, lead_id, customer_id"),
      supabase.from("customers").select("id, name, lead_id"),
    ]);
  if (jobsErr) throw jobsErr;
  if (custErr) throw custErr;

  const jobsByLead = new Map();
  const jobsByCustomer = new Map();
  for (const job of jobs || []) {
    if (job.lead_id) {
      jobsByLead.set(job.lead_id, (jobsByLead.get(job.lead_id) || 0) + 1);
    }
    if (job.customer_id) {
      jobsByCustomer.set(
        job.customer_id,
        (jobsByCustomer.get(job.customer_id) || 0) + 1
      );
    }
  }

  const customerByLead = new Map();
  for (const c of customers || []) {
    if (c.lead_id) customerByLead.set(c.lead_id, c);
  }

  return (leads || []).map((lead) => {
    const customer = customerByLead.get(lead.id) || null;
    const customerJobs = customer ? jobsByCustomer.get(customer.id) || 0 : 0;
    const daysSinceChange = ages.get(lead.id) ?? null;

    return {
      ...lead,
      daysSinceChange,
      stale: isStale({ ...lead, daysSinceChange }),
      jobCount: jobsByLead.get(lead.id) || 0,
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            jobCount: customerJobs,
            // Having zero jobs is the whole test. A customer is only ever
            // reached by another lead through a job (findOrCreateCustomer
            // matches on phone and reuses the row), so no jobs means nothing
            // else depends on it. customers.lead_id holds a single lead, so
            // counting that would always return 1 and prove nothing.
            safeToDelete: customerJobs === 0,
          }
        : null,
    };
  });
}

// Set the same status on several leads at once. Used to restore a lead that
// was moved by mistake, or to bulk-archive.
export async function bulkUpdateLeadStatus(ids, status) {
  if (!ids?.length) return;
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .in("id", ids);
  if (error) throw error;
}

// Delete several leads.
//
// Default behaviour refuses any lead that still has jobs attached — jobs
// carry final_price and payment ids the Income page reports from, so
// deleting one would destroy real revenue history (and fail on the foreign
// key besides). Those are reported back instead of deleted.
//
// `force` overrides that and deletes the jobs too. It exists because test
// leads are precisely the ones that have been run through scheduling and
// payment, so the safe path can't clear them. The UI gates it behind a
// typed confirmation.
//
// `alsoDeleteCustomers` additionally removes the customer profile a lead
// created, but only where that customer has no jobs left afterwards — a
// customer reached by another lead's job is never touched.
//
// Deletion order follows the foreign keys: job_assignments -> jobs ->
// customers -> leads.
//
// Returns { deleted, blocked, jobsDeleted, customersDeleted, customersKept }.
export async function bulkDeleteLeads(
  leads,
  { alsoDeleteCustomers = false, force = false } = {}
) {
  const deletable = force ? leads : leads.filter((l) => !l.jobCount);
  const blocked = force
    ? []
    : leads
        .filter((l) => l.jobCount > 0)
        .map((l) => ({ id: l.id, name: l.name, jobCount: l.jobCount }));

  if (deletable.length === 0) {
    return {
      deleted: [],
      blocked,
      jobsDeleted: 0,
      customersDeleted: 0,
      customersKept: [],
    };
  }

  const leadIds = deletable.map((l) => l.id);
  let jobsDeleted = 0;

  // 1. Jobs (and their tech assignments) belonging to these leads.
  if (force) {
    const { data: jobs, error: findErr } = await supabase
      .from("jobs")
      .select("id")
      .in("lead_id", leadIds);
    if (findErr) throw findErr;

    const jobIds = (jobs || []).map((j) => j.id);
    if (jobIds.length > 0) {
      const { error: assignErr } = await supabase
        .from("job_assignments")
        .delete()
        .in("job_id", jobIds);
      if (assignErr) throw assignErr;

      const { error: jobErr } = await supabase
        .from("jobs")
        .delete()
        .in("id", jobIds);
      if (jobErr) throw jobErr;

      jobsDeleted = jobIds.length;
    }
  }

  // 2. Customer profiles, re-checked against the database rather than the
  //    counts we loaded earlier — force may have just removed their jobs.
  let customersDeleted = 0;
  const customersKept = [];

  if (alsoDeleteCustomers) {
    const nameById = new Map();
    for (const lead of deletable) {
      if (lead.customer) nameById.set(lead.customer.id, lead.customer.name);
    }
    const candidateIds = [...nameById.keys()];

    if (candidateIds.length > 0) {
      const { data: remaining, error: remErr } = await supabase
        .from("jobs")
        .select("id, customer_id")
        .in("customer_id", candidateIds);
      if (remErr) throw remErr;

      const stillHasJobs = new Map();
      for (const job of remaining || []) {
        stillHasJobs.set(
          job.customer_id,
          (stillHasJobs.get(job.customer_id) || 0) + 1
        );
      }

      const toDelete = [];
      for (const id of candidateIds) {
        const n = stillHasJobs.get(id) || 0;
        if (n === 0) toDelete.push(id);
        else
          customersKept.push({
            name: nameById.get(id),
            reason: `${n} job${n === 1 ? "" : "s"}`,
          });
      }

      if (toDelete.length > 0) {
        const { error: custErr } = await supabase
          .from("customers")
          .delete()
          .in("id", toDelete);
        if (custErr) throw custErr;
        customersDeleted = toDelete.length;
      }
    }
  }

  // 3. The leads themselves.
  const { error } = await supabase.from("leads").delete().in("id", leadIds);
  if (error) throw error;

  return {
    deleted: leadIds,
    blocked,
    jobsDeleted,
    customersDeleted,
    customersKept,
  };
}

// Given a target stage and a lead, return which required field is still
// missing ('price' | 'appointment' | null). Used to prompt on drag.
export function missingFieldFor(stage, lead) {
  if (stage === "quoted" && !lead.estimate) return "price";
  if (stage === "booked" && !lead.appointment_at) return "appointment";
  return null;
}

// Create a manual (door-knock) lead at a given stage.
// createdBy = the logged-in user's id, for rep attribution.
// Returns the newly created row.
export async function createLead(lead, createdBy = null) {
  const { data, error } = await supabase
    .from("leads")
    .insert({ ...lead, source: "door", created_by: createdBy })
    .select()
    .single();

  if (error) throw error;
  return data;
}