import { useOutletContext, useParams } from "react-router-dom";
import QuotesPanel from "../../components/QuotesPanel";

// The header is LeadLayout's now, not this page's — but the panel below
// still uses .detail spacing, so the stylesheet stays.
import "./LeadDetail.css";

/**
 * Quotes for one lead, on their own page.
 *
 * Lifted off the lead page as part of splitting it up — see RecordTabs.jsx.
 * Sending a quote is a job you sit down to do; it does not belong halfway
 * down a form you opened to fix a phone number.
 *
 * NO beforeSend HERE, and that is a real difference from the lead page.
 * There, the panel had to save the edit form before opening the modal,
 * because "Save changes" also navigated away and people lost what they had
 * typed. This page has no form to lose, so the hook is not needed and
 * passing one would be a lie about what the button does.
 */
export default function LeadQuotes() {
  const { id } = useParams();
  // THE LEAD COMES FROM THE LAYOUT. LeadLayout holds it and stays mounted
  // across the three tabs; this page used to fetch it again on arrival,
  // which is why the header blinked on every tab press.
  const { lead, reload } = useOutletContext();

  return (
    <>
      <QuotesPanel
        leadId={id}
        customerName={lead.name}
        customerEmail={lead.email}
        customerPhone={lead.phone}
        address={lead.address}
        // The saved estimate, not a form value — there is no form on this
        // page. It is only the modal's starting number and can be changed
        // there.
        suggestedAmount={Number(lead.estimate) || null}
        suggestedServices={lead.service ? [lead.service] : null}
        // A lead moves to Booked the moment a quote is accepted, and that
        // happens in the database. Reload so this page agrees with it.
        onChanged={reload}
      />
    </>
  );
}
