/*
 * The buildings a customer wants cleaned.
 *
 * See db/properties.sql. The short version: a customer can have several
 * addresses, exactly one is primary, and a job points at one of them while
 * it is still upcoming. Once a job completes its address is frozen onto the
 * job row and nothing here can move it.
 *
 * WHY THIS IS A SERVICE AND NOT THREE SUPABASE CALLS IN A COMPONENT. Two of
 * the operations below have an order or a guard that is not obvious from the
 * call site, and both have already been got wrong once:
 *
 *   setPrimary  — cannot be done as "clear then set" from a client, because
 *                 a dropped second request leaves a customer with NO primary
 *                 and the next job booked for them silently falls through to
 *                 the customer record. It goes through an RPC.
 *   archive     — is not a delete, and must refuse to orphan the default.
 */

import { supabase } from "../supabaseClient";

const COLUMNS = "id, customer_id, label, address, latitude, longitude, is_primary, archived_at, created_at";

/**
 * A customer's addresses, primary first.
 *
 * Archived ones are left out by default: the only screen that wants them is
 * one showing where an old job was, and that reads the job's frozen address
 * instead.
 */
export async function fetchProperties(customerId, { includeArchived = false } = {}) {
  if (!customerId) return [];

  let query = supabase
    .from("customer_properties")
    .select(COLUMNS)
    .eq("customer_id", customerId);

  if (!includeArchived) query = query.is("archived_at", null);

  // Primary first, then oldest first. NOT alphabetical: the order somebody
  // added their addresses in is the order they think about them in, and
  // sorting "Main house" above "Model home" because M comes first is a
  // list that reshuffles itself when a label is edited.
  const { data, error } = await query
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Add one.
 *
 * THE FIRST ONE IS AUTOMATICALLY PRIMARY. A customer with addresses but no
 * primary is a customer whose next job quietly books against their customer
 * record instead of a building, and nothing on screen would say so.
 */
export async function createProperty(customerId, { label, address, latitude, longitude }) {
  const clean = String(address ?? "").trim();
  if (!customerId) throw new Error("A property needs a customer.");
  if (!clean) throw new Error("A property needs an address.");

  const existing = await fetchProperties(customerId);

  const { data, error } = await supabase
    .from("customer_properties")
    .insert({
      customer_id: customerId,
      label: String(label ?? "").trim() || null,
      address: clean,
      // Null rather than undefined, and deliberately NOT carried over from
      // whatever was last picked: an address typed by hand has no
      // coordinates, and inheriting the previous building's would put the
      // pin on the wrong house while the text read correctly.
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      is_primary: existing.length === 0,
    })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/** Edit the label, the address, or both. */
export async function updateProperty(id, changes) {
  const patch = { ...changes };

  if ("address" in patch) {
    const clean = String(patch.address ?? "").trim();
    if (!clean) throw new Error("A property needs an address.");
    patch.address = clean;
  }
  if ("label" in patch) patch.label = String(patch.label ?? "").trim() || null;

  const { data, error } = await supabase
    .from("customer_properties")
    .update(patch)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Make this one the default.
 *
 * Through the RPC, not two updates — db/properties.sql section 6 explains
 * why at length. It also un-archives: choosing a property as the default is
 * also choosing to use it again, and a primary nobody can see in the picker
 * is the worst of the available states.
 */
export async function setPrimaryProperty(id) {
  const { error } = await supabase.rpc("sb_set_primary_property", { p_id: id });
  if (error) throw error;
}

/**
 * Stop offering it, without erasing it.
 *
 * NOT A DELETE. A property with finished jobs against it is history — the
 * jobs keep their own frozen copy of the address, but the row is still what
 * ties three visits to one building. Hiding it from the picker is the
 * actual requirement; deleting it is somebody assuming that was the same
 * thing.
 *
 * REFUSES TO ARCHIVE THE LAST ONE, and refuses to archive the primary while
 * another exists. Both would leave the customer in the state described at
 * the top of createProperty, reached by a different route.
 */
export async function archiveProperty(id) {
  const { data: row, error: readErr } = await supabase
    .from("customer_properties")
    .select("customer_id, is_primary")
    .eq("id", id)
    .single();

  if (readErr) throw readErr;

  const siblings = (await fetchProperties(row.customer_id)).filter((p) => p.id !== id);

  if (siblings.length === 0) {
    throw new Error(
      "This is the only address on file. Add another one first, or edit this one."
    );
  }
  if (row.is_primary) {
    throw new Error(
      "This is the default address. Make another one the default first."
    );
  }

  const { error } = await supabase
    .from("customer_properties")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw error;
}

/**
 * How to name a property in a list.
 *
 * A label when there is one, the address when there isn't — never "Untitled
 * property", which tells somebody choosing between two houses nothing at
 * all. The address is the fallback precisely because it is the thing that
 * distinguishes them.
 */
export function propertyName(property) {
  const label = String(property?.label ?? "").trim();
  const address = String(property?.address ?? "").trim();
  if (label && address) return `${label} — ${address}`;
  return label || address || "No address";
}
