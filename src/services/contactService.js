import { supabase } from "../supabaseClient";
// One copy, shared with textService.js — see src/services/names.js.
import { firstName } from "./names";
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

// THE ROWS THAT ARE ABOUT THEM, NOT ABOUT US.
//
// Three kinds on this timeline describe something the customer did, and all
// three used to say "they". That reads fine on a page you opened on purpose
// and badly everywhere else: the thread is keyed on the PHONE NUMBER, so one
// conversation is routinely a lead from April, a second lead from June and a
// customer — and "They called" does not say which of them called.
//
// Functions rather than strings because the possessive does not fit a
// template: "Dana called" and "Missed Dana's call" need different shapes, and
// a single "{name}" placeholder would have produced "Missed Dana call".
//
// Each falls back to the original wording when there is no name, which is an
// ordinary state — a lead from the website form with a number and nothing else.
const THEIR_SIDE = {
  call_in: (who) => (who ? `${who} called` : "They called"),
  call_missed: (who) => (who ? `Missed ${who}'s call` : "Missed their call"),
  text_in: (who) => (who ? `${who} replied` : "They replied"),
};

const CONTACT_KINDS = {
  // A call somebody actually had. Since db/call-tracking.sql this is the
  // only kind written when Quo confirms the call connected, so "Called" on
  // this timeline now means a conversation happened rather than that
  // somebody pressed a button.
  call: "Called",
  // Rang, nobody picked up. A real outbound call — Quo placed it — and
  // deliberately not "Called": the difference between "I spoke to them" and
  // "I rang twice and got nothing" is the whole content of the decision
  // somebody is making when they read this page.
  call_attempt: "Called, no answer",
  // They rang US and we picked up. Named from their side for the same
  // reason text_in is "They replied": on a timeline that otherwise reads as
  // things Sky Blue did, "Called" on a row where the customer rang you says
  // the opposite of what happened.
  call_in: "They called",
  // They rang and nobody got to it — including our own voicemail answering.
  // The most useful line this timeline can carry and one it has never had,
  // because a button on a lead page cannot know about a call that never
  // reached it.
  call_missed: "Missed their call",
  text: "Texted",
  // A message FROM them. Deliberately not "Texted" — on a timeline that
  // reads as something Sky Blue did, and the difference between "we chased
  // them" and "they got back to us" is the whole point of reading the
  // history before picking the phone up.
  text_in: "They replied",
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
  services: "Services changed",
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
export function describeEvent(row, statusLabel = titleCase, theirName = null) {
  const move =
    row.from_status && row.to_status
      ? `${statusLabel(row.from_status)} → ${statusLabel(row.to_status)}`
      : null;

  if (row.source === "contact") {
    const who = firstName(theirName);
    const base =
      THEIR_SIDE[row.kind]?.(who) || CONTACT_KINDS[row.kind] || titleCase(row.kind);
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

  // A services change carries its before/after in the status columns, the
  // same way a plan change does. Without this the row would say "Services
  // changed" and nothing else, which is the least useful sentence available.
  if (row.kind === "services" && row.to_status) {
    bits.push(`${row.from_status || "Not recorded"} → ${row.to_status}`);
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

/**
 * "today at 3:14 PM", "yesterday", "4 days ago", "on Sep 12, 2026".
 *
 * Lives here rather than on the page for the same reason describeEvent()
 * does: it is wording, and the one place that decides it should be the one
 * place that is tested.
 *
 * COUNTED IN CALENDAR DAYS, not in elapsed milliseconds. The version this
 * replaced divided the gap by 86,400,000, so a call at 11pm read at 1am was
 * two hours old and therefore "today at 11:00 PM". It was yesterday. Two
 * hours is also what separates 8am from 10am on one morning; only the
 * calendar can tell those apart.
 *
 * `now` is injectable so that fact can actually be asserted. A function
 * whose whole job is being right about which day it is cannot be tested
 * against whatever day the suite happens to run on.
 */
export function whenReached(iso, now = new Date()) {
  if (!iso) return "";
  const then = new Date(iso);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(now) - midnight(then)) / 86400000);

  if (days <= 0) {
    return `today at ${then.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}
