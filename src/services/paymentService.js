import { supabase } from "../supabaseClient";

// Look up the payment behind a Square Point of Sale transaction.
//
// The Square app returns a transaction id when a card is tapped; this
// resolves it to the payment, so a tapped job records exactly like one
// paid through the in-app card form — same payment id, same receipt.
export async function resolvePosPayment(transactionId) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/resolve-pos-payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({ transactionId }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Couldn't find that payment in Square.");
  }
  return data; // { paymentId, receiptUrl, amount, card, squareCustomerId, ... }
}

// Charge a card through our Netlify function, which holds the Square
// secret. Pass EITHER sourceId (a fresh token from the Web Payments SDK)
// or savedCardId (a "ccof:..." card on file from a previous visit).
export async function chargeCard({
  sourceId,
  savedCardId,
  verificationToken,
  amount,
  customerName,
  customerEmail,
  customerPhone,
  squareCustomerId,
  saveCard = false,
  description,
  referenceId,
}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch("/api/create-payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      sourceId,
      savedCardId,
      verificationToken,
      amount,
      customerName,
      customerEmail,
      customerPhone,
      squareCustomerId,
      saveCard,
      description,
      referenceId,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // data.error is already written for the customer; data.detail and
    // data.code are the developer view, logged rather than displayed.
    if (data.detail || data.code) {
      console.error("Square declined:", data.code, data.detail);
    }
    throw new Error(data.error || "The card couldn't be charged.");
  }
  return data; // { paymentId, status, receiptUrl, squareCustomerId, card, cardSaveFailed }
}

// Remember the Square customer + card on file so the next visit can be
// charged without re-entering the card.
export async function saveCardOnCustomer(
  customerId,
  { squareCustomerId, card }
) {
  if (!customerId) return;

  const changes = {};
  if (squareCustomerId) changes.square_customer_id = squareCustomerId;

  // The brand/last4/expiry columns describe the card in square_card_id —
  // they're what the complete-job screen shows above "Charge $X to
  // ····4242". So they only move when the stored card itself moves.
  //
  // Without the card.id guard, a card TAPPED through the Square app would
  // rewrite the display fields while square_card_id kept pointing at a
  // different, still-stored card: the screen would offer to charge one
  // card and actually charge another. A tap is never stored on file, so it
  // has no id and correctly changes nothing here.
  if (card?.id) {
    changes.square_card_id = card.id;
    changes.card_brand = card.brand;
    changes.card_last4 = card.last4;
    changes.card_exp_month = card.expMonth;
    changes.card_exp_year = card.expYear;
  }
  if (Object.keys(changes).length === 0) return;

  const { error } = await supabase
    .from("customers")
    .update(changes)
    .eq("id", customerId);
  if (error) throw error;
}

// Record which Square payment settled a job, and where its receipt lives.
//
// The receipt url matters more than it looks: Square hosts a permanent,
// printable page for every card payment — the same document the customer
// gets. Keeping the link means a completed job can show its receipt later
// without the CRM generating anything itself. It was being returned by
// create-payment and thrown away here.
export async function savePaymentOnJob(jobId, { paymentId, receiptUrl } = {}) {
  const changes = { square_payment_id: paymentId };
  if (receiptUrl) changes.receipt_url = receiptUrl;

  const { error } = await supabase
    .from("jobs")
    .update(changes)
    .eq("id", jobId);
  if (error) throw error;
}

// Drop a stored card — used when a customer's card expires or they ask
// us to forget it. Clears our copy; the parent can also delete it in
// Square if desired.
export async function forgetSavedCard(customerId) {
  const { error } = await supabase
    .from("customers")
    .update({
      square_card_id: null,
      card_brand: null,
      card_last4: null,
      card_exp_month: null,
      card_exp_year: null,
    })
    .eq("id", customerId);
  if (error) throw error;
}
