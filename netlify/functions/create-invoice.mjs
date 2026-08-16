// netlify/functions/create-invoice.mjs
//
// Creates and emails a Square invoice for a completed job.
// Flow: verify CRM login -> find/create Square customer -> create order
//       -> create draft invoice -> publish (Square emails the customer).
//
// Required Netlify environment variables (NO VITE_ prefix — server-only):
//   SQUARE_ACCESS_TOKEN  — from Square Developer Dashboard (sandbox or production)
//   SQUARE_LOCATION_ID   — your Square location id (matching the environment)
//   SQUARE_ENV           — "sandbox" or "production"
// (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are already set and readable here.)

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
    throw new Error(`Square ${path}: ${detail}`);
  }
  return data;
}

// Verify the request comes from a logged-in CRM user by checking their
// Supabase session token.
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

  const { customerName, customerEmail, amount, description, dueDate } = payload;

  if (!customerName || !customerEmail || !amount) {
    return Response.json(
      { error: "customerName, customerEmail, and amount are required" },
      { status: 400 }
    );
  }

  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return Response.json({ error: "Invalid amount" }, { status: 400 });
  }

  const locationId = process.env.SQUARE_LOCATION_ID;

  try {
    // 1. Find the customer in Square by email, or create them.
    const search = await square("/v2/customers/search", "POST", {
      query: { filter: { email_address: { exact: customerEmail } } },
    });
    let customerId = search.customers?.[0]?.id;
    if (!customerId) {
      const created = await square("/v2/customers", "POST", {
        idempotency_key: crypto.randomUUID(),
        given_name: customerName,
        email_address: customerEmail,
      });
      customerId = created.customer.id;
    }

    // 2. Create the order (one line item for the job).
    const orderRes = await square("/v2/orders", "POST", {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId,
        line_items: [
          {
            name: description || "Window cleaning service",
            quantity: "1",
            base_price_money: { amount: cents, currency: "USD" },
          },
        ],
      },
    });
    const orderId = orderRes.order.id;

    // 3. Create the draft invoice (emailed, payable by card).
    const due =
      dueDate ||
      new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const invRes = await square("/v2/invoices", "POST", {
      idempotency_key: crypto.randomUUID(),
      invoice: {
        location_id: locationId,
        order_id: orderId,
        primary_recipient: { customer_id: customerId },
        delivery_method: "EMAIL",
        title: "Sky Blue Cleaning Co.",
        description: description || "Thank you for your business!",
        accepted_payment_methods: { card: true },
        payment_requests: [{ request_type: "BALANCE", due_date: due }],
      },
    });
    const invoice = invRes.invoice;

    // 4. Publish — this is what makes Square actually email it.
    const pubRes = await square(`/v2/invoices/${invoice.id}/publish`, "POST", {
      version: invoice.version,
      idempotency_key: crypto.randomUUID(),
    });

    return Response.json({
      invoiceId: pubRes.invoice.id,
      invoiceNumber: pubRes.invoice.invoice_number,
      publicUrl: pubRes.invoice.public_url,
      status: pubRes.invoice.status,
    });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/create-invoice",
};
