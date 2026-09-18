import QuoteModal from "./QuoteModal";
import { quotable } from "../services/quoteService";

/**
 * Offer to send the quote for a lead that was just created at the Quoted
 * stage.
 *
 * A lead cannot be saved as "quoted" without a price — both forms enforce
 * that — so by the time this renders, a quote genuinely exists. It just
 * exists in somebody's head, and the step of actually sending it is the one
 * that gets skipped while standing on a driveway.
 *
 * Its own component because there are two ways into the CRM with a lead —
 * the New lead page and the pin on the map — and the second one is exactly
 * the case this matters most for. Two copies of the same offer is how they
 * end up behaving differently.
 *
 * Everything is read from the CREATED ROW rather than from the form that
 * made it. The row is what the database actually holds: it carries the
 * defaults the form left blank and any normalising createLead did on the way
 * through, so the quote is built from what is true rather than from what was
 * typed.
 */

export default function QuoteAfterCreate({ lead, onDone }) {
  if (!quotable(lead)) return null;

  return (
    <QuoteModal
      leadId={lead.id}
      customerName={lead.name}
      customerEmail={lead.email || null}
      customerPhone={lead.phone || null}
      address={lead.address || null}
      suggestedAmount={Number(lead.estimate) || null}
      suggestedServices={lead.service ? [lead.service] : null}
      // Sent or not, the lead is created and nothing here is unsaved, so
      // closing means the same thing either way.
      onClose={onDone}
      onSent={() => {}}
    />
  );
}
