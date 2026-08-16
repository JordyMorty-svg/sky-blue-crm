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