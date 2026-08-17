// netlify/functions/create-payment.mjs
//
// Charges a card for a job that's being paid right now, in the field.
//
// Two ways in:
//   1. sourceId  — a fresh one-time token from the Web Payments SDK.
//                  Optionally stores the card on file afterwards.
//   2. savedCardId — a "ccof:..." id from a previous visit. Repeat
//                  customers get charged without re-entering anything.
//
// Required Netlify environment variables (server-only, no VITE_ prefix):
//   SQUARE_ACCESS_TOKEN  — from the Square Developer Dashboard
//   SQUARE_LOCATION_ID   — must match the environment below
//   SQUARE_ENV           — "sandbox" or "production"

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

// Find the Square customer by email, or make one. We need a customer
// record before a card can be stored against it.
async function findOrCreateSquareCustomer({ squareCustomerId, name, email, phone }) {
  if (squareCustomerId) return squareCustomerId;

  if (email) {
    const search = await square("/v2/customers/search", "POST", {
      query: { filter: { email_address: { exact: email } } },
    });
    const found = search.customers?.[0]?.id;
    if (found) return found;
  }

  const created = await square("/v2/customers", "POST", {
    idempotency_key: crypto.randomUUID(),
    given_name: name || "Customer",
    email_address: email || undefined,
    phone_number: phone || undefined,
  });
  return created.customer.id;
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

  const {
    sourceId,           // fresh token from the Web Payments SDK
    savedCardId,        // or a stored "ccof:..." card id
    verificationToken,  // from verifyBuyer(), when the SDK returns one
    amount,
    customerName,
    customerEmail,
    customerPhone,
    squareCustomerId,   // already-known Square customer id, if we have one
    saveCard = false,
    description,
    referenceId,        // our job id, so payments are traceable in Square
  } = payload;

  if (!sourceId && !savedCardId) {
    return Response.json(
      { error: "A card token or a saved card is required." },
      { status: 400 }
    );
  }

  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return Response.json({ error: "Invalid amount" }, { status: 400 });
  }

  try {
    // A stored card can only be charged in the context of its customer,
    // so that path always needs a customer id up front. A fresh token
    // only needs one if we're about to save it.
    let customerId = squareCustomerId || null;
    if (savedCardId || saveCard) {
      customerId = await findOrCreateSquareCustomer({
        squareCustomerId,
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
      });
    }

    // 1. Take the payment.
    const paymentBody = {
      idempotency_key: crypto.randomUUID(),
      source_id: savedCardId || sourceId,
      amount_money: { amount: cents, currency: "USD" },
      location_id: process.env.SQUARE_LOCATION_ID,
      autocomplete: true,
      note: description || "Window cleaning service",
    };
    if (customerId) paymentBody.customer_id = customerId;
    if (verificationToken) paymentBody.verification_token = verificationToken;
    if (referenceId) paymentBody.reference_id = String(referenceId);
    // Square emails its own plain receipt too if we hand it an address.
    // Harmless alongside our branded one, and useful as a fallback.
    if (customerEmail) paymentBody.buyer_email_address = customerEmail;

    const payRes = await square("/v2/payments", "POST", paymentBody);
    const payment = payRes.payment;

    // 2. Store the card for next time, if asked. This runs AFTER a
    //    successful charge and uses the payment id as the source.
    //    A failure here must not fail the payment — the money is taken.
    let card = null;
    if (saveCard && sourceId && customerId) {
      try {
        const cardRes = await square("/v2/cards", "POST", {
          idempotency_key: crypto.randomUUID(),
          source_id: payment.id,
          card: {
            customer_id: customerId,
            reference_id: referenceId ? String(referenceId) : undefined,
          },
        });
        const c = cardRes.card;
        card = {
          id: c.id,
          brand: c.card_brand,
          last4: c.last_4,
          expMonth: c.exp_month,
          expYear: c.exp_year,
        };
      } catch (cardErr) {
        console.error("Card not saved (payment still succeeded):", cardErr);
      }
    }

    return Response.json({
      paymentId: payment.id,
      status: payment.status,
      receiptUrl: payment.receipt_url,
      squareCustomerId: customerId,
      card,
      cardSaveFailed: saveCard && !!sourceId && !card,
    });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/create-payment",
};
