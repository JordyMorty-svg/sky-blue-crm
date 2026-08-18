import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  parsePosCallback,
  posErrorMessage,
  readPendingPayment,
  clearPendingPayment,
} from "../../components/squarePos";
import "./PosReturn.css";

/**
 * Where Square Point of Sale drops you after a tap.
 *
 * This page does no work of its own beyond reading the result and sending
 * you back to the job it belongs to. Completing the job, saving the
 * payment and emailing the receipt all stay in CompleteJob, which already
 * knows how to do those things for every other payment method — a second
 * copy of that logic here is how the two quietly drift apart.
 *
 * The screen exists at all because the round trip is not instant and
 * because a failed tap needs somewhere to say so. Landing on a blank page
 * after paying is alarming in a way that matters when a customer is
 * standing next to you.
 */
export default function PosReturn() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    const result = parsePosCallback(search);

    // Not a Square callback — someone opened this URL directly.
    if (!result) {
      navigate("/schedule", { replace: true });
      return;
    }

    // Storage holds what was on screen before we left: the final amount, a
    // plan just agreed, a note, a corrected email. Square echoes only the
    // job id back, so without this the operator would have to type it all
    // again after paying.
    const pending = readPendingPayment(result.jobId);
    const jobId = result.jobId || pending?.jobId;

    if (!jobId) {
      // Nothing identifies the job, so completing it automatically isn't
      // possible. Say so rather than guessing — the money may well have
      // been taken.
      setFailure({
        message:
          "The payment came back from Square without saying which job it " +
          "was for. Check the Square app: if it went through, complete the " +
          "job here and record it as a card payment.",
        jobId: null,
      });
      return;
    }

    if (!result.ok) {
      clearPendingPayment();
      setFailure({ message: posErrorMessage(result.errorCode), jobId });
      return;
    }

    clearPendingPayment();
    // replace: true so the back button doesn't return here and re-run a
    // callback whose transaction has already been consumed.
    navigate(`/schedule/complete/${jobId}`, {
      replace: true,
      state: {
        posResult: {
          transactionId: result.transactionId,
          clientTransactionId: result.clientTransactionId,
        },
        pending,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (failure) {
    return (
      <div className="posret">
        <h1 className="posret__title">That payment didn't finish</h1>
        <p className="posret__message">{failure.message}</p>
        <div className="posret__actions">
          {failure.jobId && (
            <button
              className="posret__primary"
              onClick={() =>
                navigate(`/schedule/complete/${failure.jobId}`, { replace: true })
              }
            >
              Back to the job
            </button>
          )}
          <button
            className="posret__secondary"
            onClick={() => navigate("/schedule", { replace: true })}
          >
            Back to schedule
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="posret">
      <div className="posret__spinner" aria-hidden="true" />
      <h1 className="posret__title">Finishing up…</h1>
      <p className="posret__message">
        Square took the payment. Recording it against the job.
      </p>
    </div>
  );
}
