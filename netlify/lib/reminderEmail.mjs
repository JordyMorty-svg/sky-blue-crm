// netlify/lib/reminderEmail.mjs
//
// "We're coming tomorrow", by email.
//
// The text is the normal way a customer hears this, and for almost everyone
// it is the right one — it arrives on the phone they answer the door with.
// This exists for the case where the carrier refuses that text.
//
// That case is worse than it sounds. A refused quote can wait: the customer
// hasn't been promised anything and the nudge run will try again. A refused
// day-before confirmation expires overnight. Nobody moves the car, nobody
// unlocks the side gate, and two people drive across Corvallis to a house
// that wasn't expecting them — and the only record of why is a line in a
// webhook log.
//
// Deliberately plainer than the quote email. This is not a sales message; it
// is a reminder somebody needs to read in four seconds standing in a
// kitchen, and the time and date are the only things on it that matter.

import { esc } from "./html.mjs";
import { sendEmail } from "./email.mjs";

// Corvallis. Hardcoded for the same reason it is in sms.mjs: a reminder that
// says 8:00 AM must say the time the customer will see on their own clock,
// and the server's idea of "local" is UTC.
const ZONE = "America/Los_Angeles";

export function reminderTimes(startsAt) {
  const when = new Date(startsAt);
  return {
    day: when.toLocaleDateString("en-US", {
      timeZone: ZONE,
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
    time: when.toLocaleTimeString("en-US", {
      timeZone: ZONE,
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}

export function reminderHtml({ customerName, startsAt, address, services }) {
  const { day, time } = reminderTimes(startsAt);
  const first = String(customerName || "").trim().split(/\s+/)[0] || "there";

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:#2563eb;padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#ffffff;margin:0;font-size:1.4rem;">Sky Blue Cleaning Co.</h1>
      <p style="color:#dbeafe;margin:6px 0 0;font-size:0.9rem;">We're coming out tomorrow</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:24px;">
      <p style="margin:0 0 18px;">Hi ${esc(first)}, just confirming we'll be out tomorrow.</p>

      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        <tr>
          <td style="padding:8px 0;color:#64748b;">When</td>
          <td style="padding:8px 0;text-align:right;font-weight:700;">${esc(day)}, ${esc(time)}</td>
        </tr>
        ${address ? `<tr><td style="padding:8px 0;color:#64748b;">Where</td><td style="padding:8px 0;text-align:right;">${esc(address)}</td></tr>` : ""}
        ${services ? `<tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Service</td><td style="padding:8px 0;text-align:right;">${esc(services)}</td></tr>` : ""}
      </table>

      <p style="margin:20px 0 0;padding:12px 14px;background:#f8fafc;border-radius:10px;font-size:0.9rem;color:#475569;">
        If you can, please leave gates unlocked and move cars clear of the
        windows. We'll take care of the rest.
      </p>

      <p style="margin:20px 0 0;font-size:0.9rem;color:#64748b;">
        Need to move it? Just reply to this email or call us on
        <a href="tel:+15417303593" style="color:#2563eb;text-decoration:none;">(541) 730-3593</a>.
      </p>

      <p style="margin:22px 0 0;font-size:0.85rem;color:#94a3b8;">
        We tried to text this and it didn't go through, so we've emailed it
        instead. If your number has changed, just reply and let us know.
      </p>
    </div>
  </div>`;
}

/**
 * Send it. Resolves rather than throwing, always — the caller is a webhook
 * handler that must answer 200.
 */
export async function emailTheReminder({
  to,
  customerName,
  startsAt,
  address = null,
  services = null,
  leadId = null,
  customerId = null,
  jobId = null,
}) {
  if (!to) return { ok: false, reason: "no email address" };
  if (!startsAt) return { ok: false, reason: "no start time" };

  const { day, time } = reminderTimes(startsAt);

  return sendEmail({
    kind: "reminder",
    to,
    // The whole message in the subject line, because a reminder that is only
    // legible once opened is a reminder that gets opened the day after.
    subject: `We're cleaning your windows ${day} at ${time}`,
    html: reminderHtml({ customerName, startsAt, address, services }),
    // Only the override. The default belongs to sendEmail() and is defined
    // once there — a second copy of the RECEIPT_FROM fallback here is a
    // second place to be wrong, and being wrong means this returns "no From
    // address" and the customer is told nothing at all.
    from: process.env.REMINDER_FROM || undefined,
    replyTo: process.env.REPLY_TO || process.env.FOLLOW_UP_REPLY_TO || undefined,
    leadId,
    customerId,
    jobId,
  });
}
