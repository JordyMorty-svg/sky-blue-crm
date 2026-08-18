// netlify/functions/resolve-pos-payment.mjs
//
// Turns a Point of Sale API transaction id into a real Square payment.
//
// The Square app hands back a transaction id, not a payment id, and the
// Payments API has no way to look one up from the other directly. The
// documented route is two hops:
//
//   1. The transaction id IS an order id. Retrieve the order.
//   2. The order's tenders carry payment ids. Retrieve the payment.
//
// The payment is what has receipt_url, the settled amount, and the card
// details — everything the CRM needs to finish the job the same way it
// would for a card typed into the app.
//
// Docs: https://developer.squareup.com/docs/pos-api/payments-integration
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

  const { transactionId } = payload;
  if (!transactionId) {
    return Response.json({ error: "transactionId is required" }, { status: 400 });
  }

  try {
    // 1. The transaction id is the order id.
    const { order } = await square(`/v2/orders/${transactionId}`, "GET");

    // 2. Tenders carry the payment ids. A single tap is one tender, but a
    //    split payment is several — take them all and report the count
    //    rather than silently keeping the first.
    //
    //    payment_id ONLY, with no fallback to the tender's own id: a cash
    //    tender taken in the Square app has an id but no payment behind it,
    //    and falling back would send a tender id to the Payments API and
    //    surface Square's 404 as if the whole lookup had broken.
    const tenders = order?.tenders || [];
    const paymentIds = tenders.map((t) => t.payment_id).filter(Boolean);

    if (paymentIds.length === 0) {
      // Cash taken in the Square app lands here: it produces no payment to
      // look up. Documented behaviour, not an outage.
      return Response.json(
        {
          error:
            "Square recorded this as a transaction with no card payment " +
            "attached. If it was taken as cash in the Square app, record " +
            "it as cash here instead.",
        },
        { status: 422 }
      );
    }

    const { payment } = await square(`/v2/payments/${paymentIds[0]}`, "GET");

    return Response.json({
      paymentId: payment.id,
      status: payment.status,
      receiptUrl: payment.receipt_url,
      orderId: order.id,
      // Cents from Square, dollars for the CRM, which stores dollars.
      amount: Number(payment.amount_money?.amount || 0) / 100,
      squareCustomerId: payment.customer_id || null,
      card: payment.card_details?.card
        ? {
            brand: payment.card_details.card.card_brand,
            last4: payment.card_details.card.last_4,
            expMonth: payment.card_details.card.exp_month,
            expYear: payment.card_details.card.exp_year,
            // Deliberately no card id: a card tapped through the Square app
            // is not stored on file, so there's nothing to charge later.
            // Card-on-file still goes through the in-app form.
          }
        : null,
      splitCount: paymentIds.length,
    });
  } catch (err) {
    console.error(err);
    if (err.status === 404) {
      return Response.json(
        {
          error:
            "Square doesn't have that transaction. If the Square app is " +
            "signed in to a different account — or you're testing against " +
            "sandbox while the app is live — that's the usual cause.",
        },
        { status: 404 }
      );
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/resolve-pos-payment",
};
