// netlify/lib/quoteEmail.mjs
//
// The quote email: one template, one sender, two callers.
//
// It started as a block inside send-quote.mjs, which was right while there
// was one way a quote reached somebody. There are two now — a person presses
// "send", and the delivery webhook discovers a text was refused and sends the
// same quote by email instead — and two copies of an email template is how a
// customer gets a different-looking quote depending on which path they came
// down, with a price formatted one way here and another way there.
//
// Environment:
//   RESEND_API_KEY  — required, or nothing sends
//   QUOTE_FROM      — falls back to RECEIPT_FROM
//   REPLY_TO        — falls back to FOLLOW_UP_REPLY_TO. A customer replying
//                     to a quote is usually saying yes, so this has to be an
//                     inbox somebody reads.

import { esc, money } from "./html.mjs";
import { sendEmail } from "./email.mjs";

/**
 * The name on the bottom of it.
 *
 * Same reasoning as the texts in netlify/lib/sms.mjs: the person who pressed
 * Send signs it, and when we don't know who that was the company signs it.
 * Never a hardcoded first name — a quote from Hayden signed "Jordan" sends
 * the reply to the wrong brother.
 */
function signOff(sentByName) {
  const who = String(sentByName || "").trim().split(/\s+/)[0];
  return who ? `${esc(who)}<br/>Sky Blue Cleaning Co.` : "Sky Blue Cleaning Co.";
}

function quoteHtml({ customerName, amount, services, note, address, link, expires, sentByName }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:#2563eb;padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#ffffff;margin:0;font-size:1.4rem;">Sky Blue Cleaning Co.</h1>
      <p style="color:#dbeafe;margin:6px 0 0;font-size:0.9rem;">Your quote</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:24px;">
      <p style="margin:0 0 18px;">Hi ${esc(customerName) || "there"}, thanks for having us out. Here's your quote.</p>

      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        ${address ? `<tr><td style="padding:8px 0;color:#64748b;">Address</td><td style="padding:8px 0;text-align:right;">${esc(address)}</td></tr>` : ""}
        <tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Service</td><td style="padding:8px 0;text-align:right;">${services.map(esc).join("<br/>")}</td></tr>
        <tr><td style="padding:14px 0 0;font-weight:700;font-size:1.15rem;">Total</td><td style="padding:14px 0 0;text-align:right;font-weight:700;font-size:1.15rem;color:#2563eb;">${money(amount)}</td></tr>
      </table>

      ${note ? `<p style="margin:18px 0 0;padding:12px 14px;background:#f8fafc;border-radius:10px;font-size:0.9rem;color:#475569;">${esc(note)}</p>` : ""}

      <div style="text-align:center;margin:26px 0 8px;">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 30px;border-radius:999px;font-weight:700;font-size:1rem;">Accept this quote</a>
      </div>
      <p style="margin:0;text-align:center;font-size:0.8rem;color:#94a3b8;">Good through ${expires}. No deposit required.</p>

      <p style="margin:24px 0 0;font-size:0.85rem;color:#64748b;">
        Every job includes the screens scrubbed and rinsed, plus the sills and tracks.<br/><br/>
        Family-owned, right here in Corvallis.<br/>
        Questions? Just reply to this email &mdash; it comes straight to us.
      </p>

      <p style="margin:18px 0 0;font-size:0.85rem;color:#0f172a;">
        Thanks,<br/>
        ${signOff(sentByName)}
      </p>
    </div>
  </div>`;
}

/**
 * Send it. Resolves rather than throwing, always.
 *
 * Both callers are in the middle of something that has already partly
 * succeeded — a quote exists, or a text has already been recorded as
 * undelivered — and neither can undo its work because Resend was down. So
 * the result is reported, not raised.
 */
export async function emailTheQuote({
  to,
  customerName,
  amount,
  services = [],
  note = null,
  address = null,
  link,
  expires = null,
  sentByName = null,
  leadId = null,
  customerId = null,
  quoteId = null,
  sentBy = null,
  // 'quote' when a person pressed Send, 'quote_fallback' when the delivery
  // webhook is emailing one whose text the carrier refused. Two words rather
  // than one because the failures list reads very differently when the thing
  // that bounced was itself a rescue attempt.
  kind = "quote",
  force = false,
}) {
  // Through sendEmail(), not a fetch of its own: that is what records the
  // send and refuses an address we already know is dead. See
  // netlify/lib/email.mjs.
  return sendEmail({
    kind,
    to,
    subject: `Your Sky Blue Cleaning quote — ${money(amount)}`,
    html: quoteHtml({
      customerName,
      amount,
      services,
      note,
      address,
      link,
      expires,
      sentByName,
    }),
    from: process.env.QUOTE_FROM || process.env.RECEIPT_FROM,
    replyTo: process.env.REPLY_TO || process.env.FOLLOW_UP_REPLY_TO || undefined,
    leadId,
    customerId,
    quoteId,
    sentBy,
    // A quote is sent because a person decided to send it. If they are
    // emailing an address the automation gave up on, they have a reason —
    // they just spoke to the customer, or the address has been corrected.
    //
    // The automatic fallback path does NOT force: it passes force: false,
    // because nothing there knows anything the bounce didn't.
    force,
  });
}

export { quoteHtml };
