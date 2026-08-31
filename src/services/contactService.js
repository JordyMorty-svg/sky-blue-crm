import { supabase } from "../supabaseClient";
import { planFor } from "./leadService";

/**
 * One person's contact history, across the lead/customer boundary.
 *
 * A person exists twice in this CRM — as a lead while you're chasing them,
 * and as a customer once they book — and nothing in the schema joins the two
 * rows. db/contact-history.sql resolves them three ways at once (lead id,
 * customer id, normalised phone), so all of this goes through the database
 * rather than trying to stitch it together here.
 */

// Every contact, lead milestone and job milestone for whoever this id
// belongs to, oldest first. Pass whichever id you have.
export async function fetchContactTimeline({ leadId = null, customerId = null }) {
  const { data, error } = await supabase.rpc("contact_timeline", {
    p_lead_id: leadId,
    p_customer_id: customerId,
  });
  if (error) throw error;
  return data || [];
}

// Log an outreach attempt. The database decides which ids to stamp and
// whether the lead's status should advance — see record_contact().
export async function recordContact({
  leadId = null,
  customerId = null,
  kind = "call",
  detail = null,
}) {
  const { data, error } = await supabase.rpc("record_contact", {
    p_lead_id: leadId,
    p_customer_id: customerId,
    p_kind: kind,
    p_detail: detail,
  });
  if (error) throw error;
  return data;
}

// --- wording ---------------------------------------------------------------
//
// The SQL returns raw values and the labels live here, the same way
// SERVICE_PLANS owns plan wording. Renaming "Booked" is a one-line change
// rather than a migration.

const CONTACT_KINDS = {
  call: "Called",
  text: "Texted",
  email: "Emailed",
  note: "Note",
  // Written by the follow-up automation, never by a person. Named
  // differently from a hand-sent email on purpose: "Emailed" on a timeline
  // implies somebody sat down and wrote it, and the difference matters when
  // a customer replies and you're working out what they're replying to.
  auto_email: "Automatic email",
  opt_out: "Unsubscribed",
};

const JOB_KINDS = {
  created: "Job added",
  scheduled: "Job booked",
  rescheduled: "Job moved",
  plan: "Plan changed",
  property: "Property type changed",
  price: "Quote updated",
  completed: "Job completed",
  payment: "Payment taken",
  invoice: "Invoice sent",
  cancelled: "Job cancelled",
  status: "Job status changed",
};

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A timeline row as a headline plus a supporting line.
 *
 * `tone` drives the dot colour: this is the one place that decides what
 * counts as a money event versus context, so the page doesn't have to know
 * anything about event kinds.
 */
export function describeEvent(row, statusLabel = titleCase) {
  const move =
    row.from_status && row.to_status
      ? `${statusLabel(row.from_status)} → ${statusLabel(row.to_status)}`
      : null;

  if (row.source === "contact") {
    const base = CONTACT_KINDS[row.kind] || titleCase(row.kind);
    return {
      // A call that also moved the lead says so on the same line, because it
      // was one action — see the from_status/to_status columns on contact_log.
      title: move ? `${base} · ${move}` : base,
      meta: row.detail || "",
      tone: "contact",
    };
  }

  if (row.source === "lead") {
    if (!row.from_status) {
      return {
        title: "Added as a lead",
        meta: row.to_status ? statusLabel(row.to_status) : "",
        tone: "lead",
      };
    }
    return { title: move || "Status changed", meta: "", tone: "lead" };
  }

  // source === "job"
  const base = JOB_KINDS[row.kind] || titleCase(row.kind);
  const bits = [];

  // Which job this was. "Job completed" on its own says nothing when a
  // recurring customer has four of them.
  const which = jobLabel(row);
  if (which) bits.push(which);

  // The date the WORK happened, which isn't the date the event was
  // recorded — a job completed on the 27th can be submitted that evening,
  // and a cancelled one is cancelled days before it was due.
  //
  // Skipped for scheduled/rescheduled, whose own detail already spells the
  // date out ("Moved from Aug 25 to Aug 27").
  if (row.job_date && row.kind !== "scheduled" && row.kind !== "rescheduled") {
    bits.push(jobDate(row.job_date));
  }

  if (row.amount != null) bits.push(money(row.amount));
  if (row.payment_method) bits.push(titleCase(row.payment_method));
  if (row.detail) bits.push(row.detail);

  return {
    title: base,
    meta: bits.join(" · "),
    tone: row.kind === "payment" ? "money" : "job",
  };
}

// "Quarterly visit 2", "One-off extra", "Visit 3", or nothing.
//
// Nothing is the right answer for a customer's only job: "Visit 1" on a
// one-time clean is noise, and the whole point of this label is telling
// several jobs apart.
function jobLabel(row) {
  if (row.is_extra) return "One-off extra";

  const plan = row.service_plan || "one_time";
  const visit = row.visit_number;

  if (plan !== "one_time") {
    return visit ? `${planFor(plan).label} visit ${visit}` : planFor(plan).label;
  }
  return visit > 1 ? `Visit ${visit}` : "";
}

// The day the work was booked for. No time — on a timeline that already
// carries a timestamp per row, the hour is noise.
function jobDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function money(n) {
  return `$${Number(n || 0).toLocaleString()}`;
}

export function formatStamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
