// netlify/functions/get-invoice.mjs
//
// Reads the CURRENT state of a Square invoice.
//
// create-invoice records the status at the moment it publishes, which is
// always UNPAID — the customer hasn't opened the email yet. Nothing after
// that ever asked Square again, so a job stayed "awaiting payment" forever
// even once the money had landed. This is what asks.
//
// Required Netlify environment variables (NO VITE_ prefix — server-only):
//   SQUARE_ACCESS_TOKEN, SQUARE_ENV
// (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are already set here.)

const SQUARE_VERSION = "2026-01-22";

function squareBase() {
  return process.env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

async function square(path, method, body) {
  const res = await fetch(squareBase() + path, {
    method,
    headers: {
      "Square-Version": SQUARE_VERSION,
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || res.statusText;
    const err = new Error(`Square ${path}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function verifyUser(req) {
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return false;
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  return res.ok;
}

// Square's invoice statuses, reduced to the question the CRM asks: has the
// money arrived? PARTIALLY_PAID deliberately counts as NOT settled — a
// deposit isn't payment, and treating it as one would quietly overstate
// income.
const SETTLED = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"];

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!(await verifyUser(req))) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { invoiceId } = payload;
  if (!invoiceId) {
    return Response.json({ error: "invoiceId is required" }, { status: 400 });
  }

  try {
    const { invoice } = await square(`/v2/invoices/${invoiceId}`, "GET");

    // How much has actually been collected, across payment requests.
    const paidCents = (invoice.payment_requests || []).reduce(
      (sum, r) => sum + Number(r.total_completed_amount_money?.amount || 0),
      0
    );

    return Response.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      status: invoice.status,
      publicUrl: invoice.public_url,
      paid: SETTLED.includes(invoice.status),
      paidAmount: paidCents / 100,
    });
  } catch (err) {
    console.error(err);
    // A deleted or wrong-environment invoice is a 404 from Square, and
    // that's worth telling apart from a genuine outage: sandbox invoice
    // ids do not exist in production and vice versa.
    if (err.status === 404) {
      return Response.json(
        {
          error:
            "Square doesn't have that invoice. If you recently switched " +
            "between sandbox and production, invoices don't carry over.",
        },
        { status: 404 }
      );
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/get-invoice",
};
