// netlify/functions/ack-leads.mjs
//
// "Thanks for reaching out" — about a minute after the form is submitted.
//
// Somebody fills in the form on skybluecleaningco.com at nine on a Sunday
// night. Until this existed, nothing happened until one of the brothers next
// opened the CRM, and in the meantime the person had no way to know the
// message had arrived — so they filled in the next company's form too.
//
// WHY A MINUTE, AND WHY THAT IS THE WHOLE DESIGN
// ----------------------------------------------
// An instant auto-reply reads as a robot, and a robot saying "we'll contact
// you shortly" is worth less than silence: it tells the reader a machine has
// filed them. A minute reads as a person glancing at their phone.
//
// That one requirement is also what decides the architecture. The original
// plan was to send straight from the website's submit handler — but you
// cannot sleep for a minute in a serverless function without paying for the
// minute and risking the timeout, and a handler that sends before the lead
// row is committed can text somebody about an enquiry that then fails to
// save. A sweep on a timer has neither problem: the row exists, the clock is
// the database's, and a failure here can never break the form.
//
// EVERY MINUTE, which looks extravagant and is not. The query touches an
// indexed column on a table with a few hundred rows and returns nothing on
// roughly 1,439 of the 1,440 daily runs. Same argument as poll-delivery.mjs:
// a scheduled function that usually finds nothing costs one invocation.

import { rpc } from "../lib/db.mjs";
import { sendSms } from "../lib/sms.mjs";
import { sendEmail } from "../lib/email.mjs";

// The message. Deliberately short, deliberately not clever.
//
// It names the business because it arrives from a number they have never
// seen. It promises a person, because that is the only thing an automatic
// message can usefully say — anything about price or timing would be a
// guess, and a wrong guess from a robot is how a job is lost before anyone
// has spoken to anybody.
//
// No link, no "reply STOP to opt out" either: this is a one-off reply to
// somebody who just handed over their number asking to be contacted, not a
// campaign. The inbound STOP handler still works if they send one.
function ackText(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return (
    `${first ? `Hi ${first}, t` : "T"}hanks for reaching out to Sky Blue ` +
    `Cleaning. We've got your message and someone will contact you shortly ` +
    `to go over the details and get you an accurate quote.`
  );
}

function ackEmail(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return {
    subject: "Thanks for reaching out — Sky Blue Cleaning",
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;color:#0f172a;line-height:1.55">
        <p>${first ? `Hi ${first},` : "Hi,"}</p>
        <p>
          Thanks for reaching out to Sky Blue Cleaning. We've got your message
          and someone will contact you shortly to go over the details and get
          you an accurate quote.
        </p>
        <p>— Jordan &amp; Hayden<br>Sky Blue Cleaning</p>
      </div>`,
    text:
      `${first ? `Hi ${first},` : "Hi,"}\n\n` +
      `Thanks for reaching out to Sky Blue Cleaning. We've got your message ` +
      `and someone will contact you shortly to go over the details and get ` +
      `you an accurate quote.\n\n— Jordan & Hayden, Sky Blue Cleaning`,
  };
}

export default async () => {
  const started = Date.now();
  let texted = 0;
  let emailed = 0;
  let skipped = 0;
  const problems = [];

  try {
    const due = (await rpc("sms_due_lead_acks", { p_limit: 25 })) || [];

    for (const lead of due) {
      try {
        if (lead.out_has_sms) {
          // sendSms() does the claim ITSELF.
          //
          // Worth stating because the first draft of this called claim_sms
          // here and then sendSms, which claims again — the second claim hit
          // the dedupe index, came back 'already_sent', and the message was
          // never sent at all. A feature that silently does nothing, built
          // out of two functions that both work.
          //
          // force: true bypasses quiet hours deliberately.
          // sb_sms_quiet_now() exists to stop the CRM texting somebody at
          // 11pm about a quote they never asked about. This is the opposite
          // case: they typed their number into a form sixty seconds ago
          // asking to be contacted. A reply to an inbound request is not a
          // solicitation, and holding it until 9am would mean somebody who
          // wrote in at midnight hears nothing for nine hours — which is the
          // whole problem this exists to fix. It does NOT bypass an opt-out,
          // and nothing should.
          const sent = await sendSms({
            kind: "ack",
            phone: lead.out_phone,
            body: ackText(lead.out_name),
            leadId: lead.out_lead_id,
            force: true,
          });

          if (sent?.ok) texted += 1;
          // 'already_sent' is the overlap guard doing its job on two runs
          // racing, not a fault worth counting.
          else if (sent?.reason !== "already_sent") skipped += 1;
          continue;
        }

        // No usable number. An enquiry with only an email is exactly the one
        // easiest to lose track of, so it gets the same promise by the other
        // route rather than nothing.
        if (lead.out_email) {
          const { subject, html, text } = ackEmail(lead.out_name);
          const sent = await sendEmail({
            kind: "ack",
            to: lead.out_email,
            subject,
            html,
            text,
            leadId: lead.out_lead_id,
          });
          if (sent?.ok) emailed += 1;
          else skipped += 1;
        }
      } catch (err) {
        // One bad enquiry must not abandon the rest of the batch.
        problems.push({
          lead: lead.out_lead_id,
          reason: String(err?.message || err),
        });
      }
    }

    // Quiet unless there is something to say. This runs 1,440 times a day
    // and a line every time would bury the handful that matter.
    if (texted || emailed || skipped || problems.length) {
      console.log(
        "[ack-leads]",
        JSON.stringify({
          texted,
          emailed,
          skipped,
          problems,
          ms: Date.now() - started,
        })
      );
    }

    return new Response(null, { status: 204 });
  } catch (err) {
    // Thrown, so a broken sweep shows as a failed scheduled invocation in
    // the Netlify dashboard rather than as a run that quietly finds nothing
    // forever. Silence and success look identical here otherwise.
    console.error("[ack-leads] failed", err);
    throw err;
  }
};

export const config = {
  // Every minute. The delay that matters is sb_lead_ack_delay() in the
  // database, not this — the schedule only decides how precisely that delay
  // is honoured. At one minute the worst case is a little under two.
  schedule: "* * * * *",
};
