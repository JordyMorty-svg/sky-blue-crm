import { supabase } from "../supabaseClient";

// Active pipeline stages shown on the Kanban board, in order.
// 'won' and 'lost' are intentionally excluded — won leads live on the
// separate archive page; lost leads drop off the active board.
export const PIPELINE_STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
];

// Every possible status (used for reference / labels).
export const ALL_STATUSES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "archived", label: "Archived" },
];

// Statuses a user can MANUALLY set from the Leads page (Move menu + detail
// dropdown). 'new' is website-only; 'scheduled'/'completed' are set from the
// Jobs side; 'archived' is allowed (admin-permission gating comes later).
export const LEADS_SETTABLE_STATUSES = [
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
  { key: "archived", label: "Archived" },
];

// Which stages allow manually adding a lead (door-knocking).
// 'new' is excluded — those only come from the website quote form.
export const MANUAL_ADD_STAGES = ["contacted", "quoted", "booked"];

// Lead temperature (how interested they seemed), with dot colors.
export const TEMPERATURES = [
  { key: "receptive", label: "Receptive", color: "#16a34a" }, // green
  { key: "hesitant", label: "Hesitant", color: "#f59e0b" },   // amber
  { key: "maybe", label: "Maybe", color: "#94a3b8" },         // gray
];

// Fetch all active leads (not scheduled/completed/archived), newest first.
// A 'scheduled' lead has become a job and leaves the Leads board.
export async function fetchActiveLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .not("status", "in", "(scheduled,completed,archived)")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
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