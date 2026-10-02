/**
 * Small shared formatters for anything that displays a job.
 *
 * These live here rather than in the pages because the job record and the
 * job history now both render money and payment methods, and two copies of
 * a label map is how "Emailed invoice" ends up saying something different
 * on two screens that sit one click apart.
 */

export const PAYMENT_LABELS = {
  cash: "Cash",
  check: "Check",
  card: "Card",
  tap: "Tap to pay",
  invoice: "Emailed invoice",
  // NOT "Card (Square)" any more, and not historical any more either.
  //
  // It was written when the only way money reached Square was a card, and
  // the label said so. Then Jeff Krueger paid a $3,280 invoice by ACH bank
  // transfer through Square — no card involved anywhere — and the CRM would
  // have called it a card payment. The method is about the processor, which
  // is the thing that matters for reconciling against what Square reports on
  // the 1099-K; how the customer chose to push the money is Square's
  // business, not ours.
  square: "Paid through Square",
};

export function paymentLabel(method) {
  if (!method) return "";
  return PAYMENT_LABELS[method] || method;
}

export function money(n) {
  return `$${Number(n || 0).toLocaleString()}`;
}

// The exact moment, to the minute — the whole point of recording history.
// Weekday included because "was that the Tuesday or the Thursday" is the
// question people actually ask about a job.
export function formatStamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Square's invoice statuses, in two registers.
//
// Moved here from JobRecord.jsx because a second screen now shows them, and
// this file exists precisely so two screens one click apart cannot end up
// saying different things about the same fact.
//
// Two maps rather than one because they do genuinely different jobs: the
// long form is read as a sentence on the job record ("Sent, not paid yet.
// Has a Download PDF button of its own."), the short form has to fit in a
// pill next to a customer's name on a 390px phone. What must NEVER differ is
// which statuses they know about — verify/record-invoice.mjs asserts the two
// maps cover exactly the same keys, because a status missing from one falls
// through to Square's raw SCREAMING_SNAKE_CASE and blows the layout apart.
// That is how PAYMENT_PENDING — an ACH still clearing, which is the normal
// state of a big invoice for several days — showed up as a wall of
// uppercase in the picker.
export const INVOICE_STATUS_LABELS = {
  DRAFT: "Not sent yet",
  UNPAID: "Sent, not paid yet",
  SCHEDULED: "Scheduled to send",
  PAYMENT_PENDING: "Payment clearing",
  PARTIALLY_PAID: "Part-paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Paid, partly refunded",
  REFUNDED: "Refunded",
  CANCELED: "Cancelled",
  FAILED: "Payment failed",
};

export const INVOICE_STATUS_SHORT = {
  DRAFT: "Draft",
  UNPAID: "Unpaid",
  SCHEDULED: "Scheduled",
  PAYMENT_PENDING: "Clearing",
  PARTIALLY_PAID: "Part paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Part refunded",
  REFUNDED: "Refunded",
  CANCELED: "Cancelled",
  FAILED: "Failed",
};
