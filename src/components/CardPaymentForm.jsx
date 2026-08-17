import { useEffect, useRef, useState } from "react";
import "./CardPaymentForm.css";

// Square's SDK is loaded from their CDN rather than npm — it has to be
// served by Square so the card fields stay inside their iframe. Card
// numbers never touch our code, which is what keeps us out of PCI scope.
const SQUARE_ENV = import.meta.env.VITE_SQUARE_ENV || "sandbox";
const SDK_URL =
  SQUARE_ENV === "production"
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";

let sdkPromise = null;

// Load the script once per page, even if the component mounts twice.
function loadSquareSdk() {
  if (window.Square) return Promise.resolve(window.Square);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () =>
      window.Square
        ? resolve(window.Square)
        : reject(new Error("Square SDK loaded but window.Square is missing."));
    script.onerror = () =>
      reject(new Error("Couldn't load Square. Check your connection."));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Renders Square's hosted card fields and hands the parent a payment token.
 *
 * onToken({ sourceId, verificationToken, saveCard }) fires once the card
 * tokenizes. The parent is responsible for the actual charge.
 */
export default function CardPaymentForm({
  amount,
  customerName,
  customerEmail,
  onToken,
  disabled = false,
}) {
  const containerRef = useRef(null);
  const cardRef = useRef(null);
  const paymentsRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [saveCard, setSaveCard] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const appId = import.meta.env.VITE_SQUARE_APP_ID;
      const locationId = import.meta.env.VITE_SQUARE_LOCATION_ID;

      if (!appId || !locationId) {
        setError(
          "Card payments aren't configured — VITE_SQUARE_APP_ID and VITE_SQUARE_LOCATION_ID are missing."
        );
        return;
      }

      try {
        const Square = await loadSquareSdk();
        if (cancelled) return;

        const payments = Square.payments(appId, locationId);
        paymentsRef.current = payments;

        const card = await payments.card();
        if (cancelled) {
          await card.destroy();
          return;
        }

        await card.attach(containerRef.current);
        cardRef.current = card;
        setReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(e.message || "Couldn't start the card form.");
      }
    }

    init();

    // Tear the iframe down on unmount, or it leaks between jobs.
    return () => {
      cancelled = true;
      const card = cardRef.current;
      cardRef.current = null;
      if (card) card.destroy().catch(() => {});
    };
  }, []);

  async function handleCharge() {
    if (!cardRef.current || working) return;
    setError("");
    setWorking(true);

    try {
      // CHARGE_AND_STORE tells Square we intend to keep the card for
      // later. Using plain CHARGE when saveCard is on gets the storage
      // step rejected.
      const verificationDetails = {
        amount: String(Number(amount).toFixed(2)),
        currencyCode: "USD",
        intent: saveCard ? "CHARGE_AND_STORE" : "CHARGE",
        customerInitiated: true,
        // We're standing at the door typing their card into our phone.
        sellerKeyedIn: true,
        billingContact: {
          givenName: customerName || undefined,
          email: customerEmail || undefined,
        },
      };

      const result = await cardRef.current.tokenize(verificationDetails);

      if (result.status !== "OK") {
        // Square marks the offending field inside its own iframe, so
        // repeating the same complaint underneath just doubles the noise.
        // Only speak up when Square hasn't.
        const fieldErrors = (result.errors || []).filter((e) => e.field);
        if (fieldErrors.length > 0) return;

        throw new Error(
          result.errors?.map((e) => e.message).join(" ") ||
            "That card couldn't be read. Check the details and try again."
        );
      }

      // Buyer verification is handled inside tokenize() now — the old
      // separate verifyBuyer() call is deprecated, so there's no extra
      // verification token to pass along.
      await onToken({ sourceId: result.token, saveCard });
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't process that card.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="cardpay">
      <label className="cardpay__label">Card details</label>

      {/* Square injects its iframe here. Never put real inputs inside. */}
      <div className="cardpay__fields" ref={containerRef} />

      {!ready && !error && (
        <p className="cardpay__hint">Loading secure card form…</p>
      )}

      {error && <p className="cardpay__error">{error}</p>}

      <label className="cardpay__save">
        <input
          type="checkbox"
          checked={saveCard}
          onChange={(e) => setSaveCard(e.target.checked)}
          disabled={!ready || working}
        />
        <span>
          Save this card for future visits
          <em className="cardpay__savehint">
            Recurring customers can be charged next time without re-entering it.
          </em>
        </span>
      </label>

      <button
        type="button"
        className="cardpay__charge"
        onClick={handleCharge}
        disabled={!ready || working || disabled}
      >
        {working ? "Charging…" : `Charge $${Number(amount || 0).toFixed(2)}`}
      </button>
    </div>
  );
}
