import { supabase } from "../supabaseClient";

// Leads that have coordinates and are worth showing on the map
// (everything except archived).
export async function fetchMapLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("id, name, address, status, latitude, longitude")
    .not("latitude", "is", null)
    .not("status", "in", "(archived)");

  if (error) throw error;
  return data;
}

// Customers with coordinates, plus their most recent job status so we can
// color completed vs scheduled work.
export async function fetchMapCustomers() {
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, address, latitude, longitude, jobs ( status, starts_at )")
    .not("latitude", "is", null);

  if (error) throw error;
  return data;
}