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
  invoice: "Emailed invoice",
  // Historical: card payments recorded before they moved in-app.
  square: "Card (Square)",
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
