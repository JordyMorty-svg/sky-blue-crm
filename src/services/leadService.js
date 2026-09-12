import { addMonths } from "date-fns";
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

// Residential vs commercial. The two flyers carry different discounts for
// the same plans, so the discount is a function of both.
export const PROPERTY_TYPES = [
  { key: "residential", label: "Residential", hint: "Homes" },
  { key: "commercial", label: "Commercial", hint: "Storefronts" },
];

// Recurring service plans.
//
// The first cleaning is always full price — the discount is a property of
// "which visit is this", not of the customer — so it applies from visit 2
// onward. `months` drives when the next visit is auto-scheduled.
export const SERVICE_PLANS = [
  {
    key: "one_time",
    label: "One-time",
    months: null,
    discounts: { residential: 0, commercial: 0 },
    blurb: "Single cleaning. No discount.",
  },
  {
    key: "biannual",
    label: "BiAnnual",
    months: 6,
    discounts: { residential: 50, commercial: 25 },
    blurb: "Every 6 months. Discount off every cleaning after the first.",
  },
  {
    key: "quarterly",
    label: "Quarterly",
    months: 3,
    discounts: { residential: 100, commercial: 50 },
    blurb: "Every 3 months. Biggest discount, plus the bonuses.",
  },
];

export function planFor(key) {
  return SERVICE_PLANS.find((p) => p.key === key) || SERVICE_PLANS[0];
}

// What comes off each repeat visit for this plan on this kind of property.
export function discountFor(planKey, propertyType = "residential") {
  const { discounts } = planFor(planKey);
  return discounts[propertyType] ?? discounts.residential;
}

// What a given visit costs. Visit 1 is the full quote; every visit after it
// takes the plan discount. Never goes below zero — a $60 job on the
// residential quarterly plan is free, not minus forty.
export function priceForVisit(basePrice, planKey, visitNumber, propertyType) {
  const base = Number(basePrice) || 0;
  if (!visitNumber || visitNumber <= 1) return base;
  return Math.max(0, base - discountFor(planKey, propertyType));
}

// When the next visit is due, given when this one happened.
// Null for one-time plans — there is no next visit.
//
// date-fns rather than setMonth: the native version overflows, so a job on
// 31 August plus three months lands on 1 December instead of 30 November,
// and a quarterly customer drifts a day later every year. addMonths clamps
// to the last valid day of the target month.
export function nextVisitDate(fromISO, planKey) {
  const { months } = planFor(planKey);
  if (!months) return null;
  return addMonths(fromISO ? new Date(fromISO) : new Date(), months).toISOString();
}

// Lead temperature (how interested they seemed), with dot colors.
export const TEMPERATURES = [
  { key: "receptive", label: "Receptive", color: "#16a34a" }, // green
  { key: "hesitant", label: "Hesitant", color: "#f59e0b" },   // amber
  { key: "maybe", label: "Maybe", color: "#94a3b8" },         // gray
];

// Where a lead came from.
//
// This is the MARKETING channel — how they heard about Sky Blue — not how
// they got in touch. Someone who phones in got the number from somewhere,
// and it's that somewhere you'd spend money on again. Keeping the two
// separate is what makes "revenue by lead source" mean anything.
//
// Stored as plain text with the list owned here rather than a CHECK
// constraint on the column. A constraint that rejects a value the app
// writes fails silently at the database and is miserable to debug — the
// missing 'upcoming' status in jobs.status cost a day. Adding a source is
// one line in this array and no migration.
export const LEAD_SOURCES = [
  { key: "door", label: "Door knock", hint: "Knocked their door" },
  { key: "outreach", label: "We reached out", hint: "Cold call, email, or walked into a business" },
  { key: "website", label: "Website", hint: "Contact form on skybluecleaningco.com" },
  { key: "referral", label: "Referral", hint: "An existing customer sent them" },
  { key: "social", label: "Social media", hint: "Facebook, Instagram, Nextdoor" },
  { key: "google", label: "Google", hint: "Free search result or the Business Profile" },
  // Split out from `google` on purpose, and the split is the whole point:
  // Local Services Ads are charged per lead whether or not the customer
  // ever replies, and organic Google is free. Averaged together, "revenue
  // by lead source" cannot answer the only question worth asking of a paid
  // channel — whether it earns back what it costs.
  { key: "lsa", label: "Google Ads (LSA)", hint: "Local Services Ads — paid, charged per lead" },
  // A trade contact who passes on work they see in someone's house. Not
  // `referral`: that means a happy customer sent a friend and costs
  // nothing, whereas this is a commercial arrangement with a finder's fee
  // attached, and lumping the two together hides what the leads cost.
  { key: "partner", label: "Partner referral", hint: "A trade partner who sends us work for a finder's fee" },
  { key: "signage", label: "Sign or truck", hint: "Yard sign, decal, or flyer" },
  { key: "other", label: "Other", hint: "" },
];

// Deliberately does NOT fall back to a default source for an unknown value.
// The old display did (`source === "door" ? "Door knock" : "Website"`), which
// meant every source that wasn't door-knocking was labelled Website whether
// it was or not. Showing the raw value is ugly but honest.
export function sourceFor(key) {
  const found = LEAD_SOURCES.find((s) => s.key === key);
  if (found) return found;
  return { key: key || "unknown", label: key || "Not recorded", hint: "" };
}

// What Sky Blue actually does.
//
// THE KEYS ARE A CONTRACT WITH THE WEBSITE. skybluecleaningco.com writes
// leads.service straight into this same Supabase project, using the slugs
// from its src/data/services.jsx — so these strings have to match that file
// character for character. A typo here doesn't throw; it just quietly
// renders "gutter-cleaning" as itself on every gutter lead forever.
//
// Adding a service is: the website's services.jsx, this array, and
// sb_service_label() in db/job-services.sql (which exists so the follow-up
// email, sent on a schedule with no app running, can still name the work).
// `label` must also match sb_service_label() in db/job-services.sql word for
// word. Both end up on screen — the database's copy is written into
// jobs.services and shown on the job record and the customer profile, while
// this one drives the pickers. When they drifted ("Residential windows" here,
// "Residential window washing" there) the same job read two different ways
// on two halves of the same page.
//
// `short` has no counterpart in SQL and is free to be terse: it is only used
// where space is tight and context makes it obvious, like a board card.
export const SERVICE_TYPES = [
  {
    key: "residential-window-washing",
    label: "Residential window washing",
    short: "Windows",
    hint: "Houses. The default for a door knock.",
  },
  {
    key: "commercial-window-washing",
    label: "Commercial window washing",
    short: "Commercial",
    hint: "Storefronts and offices",
  },
  { key: "gutter-cleaning", label: "Gutter cleaning", short: "Gutters", hint: "" },
  {
    key: "screen-cleaning-repair",
    label: "Screen cleaning & repair",
    short: "Screens",
    hint: "",
  },
  { key: "pressure-washing", label: "Pressure washing", short: "Pressure", hint: "" },
  {
    key: "solar-panel-cleaning",
    label: "Solar panel cleaning",
    short: "Solar",
    hint: "",
  },
];

// What a door knock is, unless someone says otherwise.
export const DEFAULT_SERVICE = "residential-window-washing";

// Same honesty rule as sourceFor: an unrecognised slug is shown, not
// guessed. If the website adds a service before the CRM knows about it, a
// de-slugified version of its own key is the correct thing to display —
// wrong-but-plausible ("Residential windows") would be worse than ugly.
export function serviceFor(key) {
  const found = SERVICE_TYPES.find((s) => s.key === key);
  if (found) return found;
  if (!key) return { key: "unknown", label: "Not recorded", short: "—", hint: "" };
  const guess = String(key).replace(/-/g, " ");
  const label = guess.charAt(0).toUpperCase() + guess.slice(1);
  return { key, label, short: label, hint: "" };
}

// A job's services as one readable phrase. Mirrors sb_service_sentence() in
// db/job-services.sql — the database needs its own copy for the follow-up
// email, and this one exists so the CRM never has to wait for a round trip
// to render a card.
export function serviceSentence(keys, { short = false } = {}) {
  const list = (keys || []).map((k) => serviceFor(k));
  if (list.length === 0) return "";
  const pick = (s) => (short ? s.short : s.label);
  if (list.length === 1) return pick(list[0]);
  const head = list.slice(0, -1).map(pick);
  const tail = pick(list[list.length - 1]);
  // Only the first keeps its capital, so it reads as a sentence fragment:
  // "Gutter cleaning and residential windows".
  const rest = head
    .slice(1)
    .map((l) => l.toLowerCase())
    .concat(tail.toLowerCase());
  return [head[0], ...rest.slice(0, -1)].join(", ") + " and " + rest[rest.length - 1];
}

// Record that someone tried to reach this lead, and return the updated row.
//
// Goes through an RPC rather than a plain update for two reasons, both of
// which live in db/lead-contact.sql: contact_attempts has to be incremented
// server-side, and the rule about when a call may change the status belongs
// next to the data rather than in whichever screen happened to call it.
//
// The short version of that rule: status is a position in the funnel, not a
// contact log. Ringing someone who is already quoted leaves them quoted.
// Only a lead still sitting on 'new' advances, to 'contacted'.
export async function recordLeadContact(leadId) {
  const { data, error } = await supabase.rpc("record_lead_contact", {
    p_lead_id: leadId,
  });
  if (error) throw error;
  // A set-returning rpc comes back as an array; a scalar composite doesn't.
  return Array.isArray(data) ? data[0] : data;
}

// A phone number as a dialable href. Strips the formatting people type —
// "(541) 555-0101" is not a valid tel: target, 5415550101 is.
export function telHref(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
}

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
// `ownerId` narrows the board to leads that person added. "Mine" means
// created_by, because that is the only ownership a lead has — there is no
// assignment on a lead, only on the job it becomes.
export async function fetchActiveLeads(ownerId = null) {
  let query = supabase
    .from("leads")
    .select("*")
    .in(
      "status",
      PIPELINE_STAGES.map((s) => s.key)
    );

  if (ownerId) query = query.eq("created_by", ownerId);

  const { data, error } = await query.order("created_at", {
    ascending: false,
  });

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

// Everyone a lead can be attributed to. Owners included — "Hayden added
// this, not me" is as common a correction as "that was Trenton's".
export async function fetchAssignableOwners() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, commission_eligible")
    .eq("active", true)
    .order("full_name");
  if (error) throw error;
  return data || [];
}

// Change who found a lead.
//
// An RPC rather than an update to leads.created_by, because the finder's fee
// is a separate row that has to move — and be RE-RATED — with it. Trenton is
// on 15% and a tech on 10%, so the same lead is worth a different amount
// depending on whose it is, and an owner is worth nothing at all. Doing it
// in one database function keeps the credit and the money from disagreeing.
//
// Returns a sentence describing what actually happened, which the page shows
// verbatim: the outcomes differ enough (moved, removed, created, left alone
// because it was already paid) that a generic "Saved" would hide the
// important ones.
export async function reassignLead(leadId, newOwnerId) {
  const { data, error } = await supabase.rpc("sb_reassign_lead", {
    p_lead_id: leadId,
    p_new_owner: newOwnerId || null,
  });
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
export async function fetchAllLeads(ownerId = null) {
  let leadQuery = supabase
    .from("leads")
    .select("*, creator:created_by ( full_name )");

  if (ownerId) leadQuery = leadQuery.eq("created_by", ownerId);

  const { data: leads, error } = await leadQuery.order("created_at", {
    ascending: false,
  });
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

  // 3. Unlink any customer still pointing at these leads.
  //
  //    Scheduling a lead creates a customer row with lead_id set, so that
  //    reference outlives the jobs. Without clearing it the delete below
  //    fails on the foreign key — and the failure looks identical to any
  //    other error, which is a miserable thing to debug. Customers we were
  //    asked to delete are already gone by now; this catches the ones we
  //    deliberately kept.
  const { error: unlinkErr } = await supabase
    .from("customers")
    .update({ lead_id: null })
    .in("lead_id", leadIds);
  if (unlinkErr) throw unlinkErr;

  // 4. The leads themselves.
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
// What a stage needs that this lead hasn't got.
//
// Returns an ARRAY, and that is the fix rather than a refactor for its own
// sake. It used to return one field and stop at the first match, so a lead
// dragged straight from Contacted to Booked was asked for an appointment
// and never for a price — it landed on the board as Booked at $0.
//
// That was always untidy and is now expensive: leads.estimate becomes
// jobs.price when the job is scheduled, and it is the base the finder's and
// booking fees are estimated from. A $0 booking shows the rep "no quote
// yet" against work they have actually closed.
//
// Booked needs a price for the same reason Quoted does — NewLead has always
// required one for both ("A price is required for quoted or booked"), so
// this brings the board in line with the form rather than inventing a rule.
export function missingFieldFor(stage, lead) {
  const missing = [];
  if (
    (stage === "quoted" || stage === "booked") &&
    !(Number(lead.estimate) > 0)
  ) {
    missing.push("price");
  }
  if (stage === "booked" && !lead.appointment_at) missing.push("appointment");
  return missing;
}

// Create a manual lead at a given stage.
// createdBy = the logged-in user's id, for rep attribution.
// Returns the newly created row.
export async function createLead(lead, createdBy = null) {
  const { data, error } = await supabase
    .from("leads")
    // source comes from the form now. Door knock stays the fallback because
    // it's both the commonest case and what every existing row already says.
    //
    // Service defaults here rather than in each caller, so the map's
    // add-lead modal gets it too without growing a picker it doesn't need —
    // a lead added by tapping a house is a window knock until told
    // otherwise. Only CRM paths reach this function; the website inserts its
    // own rows and always sends a real service.
    .insert({
      ...lead,
      source: lead.source || "door",
      service: lead.service || DEFAULT_SERVICE,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}