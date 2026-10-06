import { supabase } from "../supabaseClient";
// Reaching outside src/ for exactly one module, and worth the oddity. The
// alternative is a second copy of the GSM-7 alphabet in the browser, which
// would be two answers to "will this be one message or two" — a question the
// person typing can see the answer to and will notice disagreeing with the
// bill. gsm.mjs imports nothing, so this pulls no server code in with it.
import { segmentsFor } from "../../netlify/lib/gsm.mjs";

/**
 * Reading and writing one text conversation.
 *
 * THE THREAD IS THE PHONE NUMBER. Not the lead, not the customer — see the
 * header of db/sms-thread.sql for why, in short: the same person is
 * routinely a lead from April, a second lead from June and a customer, and
 * the conversation on their handset is not three conversations.
 *
 * Reading goes straight to Supabase, because sms_thread() is read-only and
 * the browser is already authenticated to it. Sending goes through
 * /api/send-text, because sending needs the Quo API key and the browser must
 * never have that.
 */

/**
 * The recent end of the conversation with this number, oldest first.
 *
 * Returns [] for no number rather than throwing. A lead with no phone is an
 * ordinary thing — somebody who left an email on the website form — and the
 * thread panel should render as "no number on file", not as an error.
 */
export async function fetchThread(phone, limit = 50) {
  if (!phone) return [];

  const { data, error } = await supabase.rpc("sms_thread", {
    p_phone: phone,
    p_limit: limit,
  });
  if (error) throw error;
  return data || [];
}

/**
 * Send one text to this number and return the row it created.
 *
 * Resolves rather than throwing for "we decided not to send this" — an
 * opt-out, SMS_MODE being off, quiet hours. Those are answers, not faults,
 * and the endpoint returns them with 200 and a sentence for exactly that
 * reason. A thrown error here would put "something went wrong" on screen for
 * the one case where the CRM knows precisely what happened.
 *
 * It DOES throw on a network failure or a 500, because those are faults and
 * the only honest thing to say about them is that we do not know whether the
 * message went.
 */
export async function sendText({ phone, body, leadId = null, customerId = null }) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/send-text", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({ phone, body, leadId, customerId }),
  });

  const data = await res.json().catch(() => ({}));

  // 4xx and 5xx are faults — a malformed request, a dead session, a crash.
  // The endpoint deliberately uses 200 for a refusal it understands, so
  // anything outside that range genuinely is something going wrong.
  if (!res.ok) throw new Error(data?.error || "Couldn't send that text.");

  return data;
}

/**
 * How a bubble should be labelled and coloured.
 *
 * Kept next to the data rather than in the component, the same way
 * describeEvent() in contactService.js is: it is the one place that decides
 * what a row MEANS, so the thread can stay a list of bubbles.
 */
const AUTOMATIC = new Set([
  "quote",
  "nudge_sent",
  "nudge_viewed",
  "reminder",
  "review",
  "ack",
  "nudge_contacted",
  "nudge_quoted",
  "nudge_booked",
]);

export function describeMessage(row) {
  const mine = row.direction === "out";

  return {
    mine,
    // Who said it. "Them" is deliberately not the customer's name: the panel
    // is already on their record and repeating it on every other bubble is
    // noise.
    who: mine ? row.sent_by || (AUTOMATIC.has(row.kind) ? "Automatic" : "Sky Blue") : "Them",
    // An automatic message looks different on purpose. Reading back a
    // conversation, the difference between "Hayden wrote this" and "the
    // nightly run wrote this" changes what you say next, and the two are
    // otherwise indistinguishable.
    automatic: mine && AUTOMATIC.has(row.kind),
    state: deliveryState(row),
  };
}

/**
 * What the little line under an outgoing bubble says.
 *
 * DELIVERED IS A TIMESTAMP, NOT A STATUS, and that is load-bearing — see
 * db/delivery-controls.sql. Flipping status to 'delivered' would drop the
 * row out of the double-send index and free its dedupe slot, so confirming
 * a delivery would cause a second send. Which means delivered_at has to be
 * read on its own, and a row can be status 'sent' AND delivered at once.
 */
export function deliveryState(row) {
  if (row.direction === "in") return null;

  if (row.status === "failed" || row.status === "undelivered") {
    return { label: "Not delivered", tone: "bad", detail: row.error || "" };
  }
  if (row.delivered_at) return { label: "Delivered", tone: "good", detail: "" };
  if (row.status === "sent") return { label: "Sent", tone: "ok", detail: "" };
  if (row.status === "queued") return { label: "Sending…", tone: "ok", detail: "" };
  return null;
}

/**
 * What a message will cost to send, for the counter under the composer.
 *
 * Re-exported from the shared module rather than reimplemented. The GSM-7
 * alphabet decides how a text is billed, and two copies of it would be two
 * answers to "will this be one message or two" — which is a question the
 * person typing can see the answer to and will notice disagreeing.
 */
export { segmentsFor };

/**
 * A number formatted the way it reads on a phone, or whatever was typed.
 *
 * Deliberately permissive. Numbers arrive in this CRM however somebody
 * entered them, and an extension or a note in the phone field is better
 * shown as-is than reformatted into nonsense.
 */
export function prettyPhone(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return String(phone ?? "");
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
