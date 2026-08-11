import { supabase } from "../supabaseClient";

// All customers, newest first.
export async function fetchCustomers() {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}

// A single customer with all their jobs (their history).
export async function fetchCustomer(id) {
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("*")
    .eq("id", id)
    .single();
  if (custErr) throw custErr;

  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("*, assignments:job_assignments ( tech:tech_id ( full_name ) )")
    .eq("customer_id", id)
    .order("starts_at", { ascending: false, nullsFirst: false });
  if (jobsErr) throw jobsErr;

  return { customer, jobs };
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