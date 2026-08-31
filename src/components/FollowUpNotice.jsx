import { useEffect, useState } from "react";
import {
  fetchFollowUp,
  skipFollowUp,
  describeFollowUp,
} from "../services/followUpService";
import "./FollowUpNotice.css";

/**
 * "Review request goes out Thursday" — and the button that stops it.
 *
 * Sits on the record page for a completed job. The three-day wait is the
 * only window there is to call an email off, so the fact that one is coming
 * has to be visible without going looking for it; an automation nobody can
 * see is one that eventually surprises somebody.
 *
 * Self-fetching and quiet on failure, like JobHistory: if
 * db/follow-ups.sql hasn't been run, or the job predates it, this renders
 * nothing rather than breaking the page around it.
 */
export default function FollowUpNotice({ jobId, className = "" }) {
  const [row, setRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;

    void (async () => {
      try {
        const found = await fetchFollowUp(jobId);
        if (!cancelled) setRow(found);
      } catch (e) {
        console.error(e);
        if (!cancelled) setRow(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  async function handleSkip() {
    setBusy(true);
    setError("");
    try {
      await skipFollowUp(jobId, "Skipped by hand");
      setRow(await fetchFollowUp(jobId));
    } catch (e) {
      console.error(e);
      setError("Couldn't cancel it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const state = describeFollowUp(row);
  if (!state) return null;

  return (
    <div className={className ? `fup ${className}` : "fup"}>
      <span className={`fup__dot fup__dot--${state.tone}`} />
      <span className="fup__text">{state.text}</span>
      {state.canSkip && (
        <button
          type="button"
          className="fup__skip"
          onClick={handleSkip}
          disabled={busy}
        >
          {busy ? "…" : "Don't send"}
        </button>
      )}
      {error && <span className="fup__error">{error}</span>}
    </div>
  );
}
