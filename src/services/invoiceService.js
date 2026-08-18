import { supabase } from "../supabaseClient";

// Calls our Netlify function, which holds the Square secret and does the
// find-customer -> order -> invoice -> publish flow. Sends the current
// Supabase session token so the function can verify we're logged in.
export async function createSquareInvoice({
  customerName,
  customerEmail,
  amount,
  description,
}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/create-invoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({ customerName, customerEmail, amount, description }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Couldn't create the invoice.");
  }
  return data; // { invoiceId, invoiceNumber, publicUrl, status }
}

// Sends a branded receipt email for a paid job (cash/check/square).
export async function sendReceipt({
  customerName,
  customerEmail,
  amount,
  method,
  description,
  address,
}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/send-receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      customerName,
      customerEmail,
      amount,
      method,
      description,
      address,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Couldn't send the receipt.");
  }
  return data;
}

// Record the invoice on the job.
//
// paid: false is right here and only here — an invoice is emailed, not
// collected. It becomes true when Square says the money arrived, which is
// what refreshInvoiceOnJob is for.
export async function saveInvoiceOnJob(jobId, { invoiceId, publicUrl, status }) {
  const { error } = await supabase
    .from("jobs")
    .update({
      square_invoice_id: invoiceId,
      invoice_url: publicUrl,
      invoice_status: status,
      paid: false,
    })
    .eq("id", jobId);
  if (error) throw error;
}

// Ask Square what an invoice's status is right now.
export async function fetchInvoiceStatus(invoiceId) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/get-invoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({ invoiceId }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Couldn't check the invoice.");
  }
  return data; // { status, publicUrl, paid, paidAmount, invoiceNumber }
}

// Bring a job's invoice status back in line with Square.
//
// The CRM stores the status from the moment the invoice was published,
// which is always UNPAID — the customer hasn't opened the email yet. When
// they pay, Square knows and nothing tells the CRM, so the job sits on
// "awaiting payment" indefinitely while the money is already in.
//
// Square is the authority on whether an invoice is paid, so this reads
// from there rather than offering a "mark as paid" button, which would
// just let the two drift apart in a new and more confusing way.
//
// Returns the fresh status, or null when there's nothing to check.
export async function refreshInvoiceOnJob(job) {
  if (!job?.id || !job.square_invoice_id) return null;

  const fresh = await fetchInvoiceStatus(job.square_invoice_id);

  // Only write when something actually moved — re-writing an unchanged
  // status on every page view is pointless traffic against the jobs table.
  const changes = {};
  if (fresh.status && fresh.status !== job.invoice_status) {
    changes.invoice_status = fresh.status;
  }
  if (fresh.paid !== job.paid) changes.paid = fresh.paid;
  if (fresh.publicUrl && fresh.publicUrl !== job.invoice_url) {
    changes.invoice_url = fresh.publicUrl;
  }

  if (Object.keys(changes).length > 0) {
    const { error } = await supabase
      .from("jobs")
      .update(changes)
      .eq("id", job.id);
    if (error) throw error;
  }

  return { ...fresh, changed: Object.keys(changes).length > 0, changes };
}