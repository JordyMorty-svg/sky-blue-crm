import { useCallback, useMemo, useState } from "react";
import {
  FALLBACK_HOURS,
  explainDuration,
  suggestDuration,
} from "../services/durationService";

/**
 * The duration field's state, shared by every screen that books a job.
 *
 * ---------------------------------------------------------------------------
 * WHY A HOOK AND NOT A DEFAULT VALUE
 * ---------------------------------------------------------------------------
 *
 * `useState(suggestDuration(...))` looks like it would do, and it is wrong in
 * a way that only shows up in use: the price and the services are picked
 * AFTER the field is first rendered. A one-shot default computes itself from
 * an empty lead, lands on nothing, and never moves again. The field has to
 * keep following the inputs until somebody takes it over.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS ENFORCES: A SUGGESTION NEVER OVERWRITES A PERSON
 * ---------------------------------------------------------------------------
 *
 * The moment the field is typed in, `override` stops being null and the
 * suggestion stops touching it — for the rest of the session, including when
 * the price is edited afterwards. Someone who has stood outside the house and
 * typed 6 does not want 4.5 back because they then corrected the quote by
 * twenty dollars. `reset()` is the way back, and it is offered on screen so
 * the auto value is never unreachable.
 *
 * @param {object}   opts
 * @param {number}   opts.price         the quoted ticket
 * @param {string[]} opts.serviceKeys   SERVICE_TYPES slugs
 */
export function useSuggestedDuration({ price, serviceKeys }) {
  // null means "nobody has touched this, follow the suggestion".
  const [override, setOverride] = useState(null);

  // Joined rather than passed raw: serviceKeys is usually a fresh array on
  // every render, so depending on the array itself would recompute forever.
  const keysKey = (serviceKeys || []).join(",");

  const suggestion = useMemo(
    () => suggestDuration({ price, serviceKeys }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [price, keysKey]
  );

  const explanation = useMemo(
    () => explainDuration({ price, serviceKeys }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [price, keysKey]
  );

  const duration = override !== null ? override : suggestion ?? FALLBACK_HOURS;

  const onChange = useCallback((value) => setOverride(value), []);
  const reset = useCallback(() => setOverride(null), []);

  /**
   * Seed from a job that is already booked. What is in the database was
   * chosen by a person at some point, so it takes over the field rather than
   * being re-suggested out from under them — an edit screen that silently
   * changed the saved duration on open would be a data loss bug wearing a
   * helpful hat.
   */
  const adopt = useCallback((value) => {
    if (value === null || value === undefined || value === "") return;
    setOverride(value);
  }, []);

  return {
    duration,
    suggestion,
    explanation,
    /** True when the field is showing a live suggestion rather than a choice. */
    isAuto: override === null && suggestion !== null,
    /** True when a person's value differs from what would be suggested. */
    isOverridden:
      override !== null && suggestion !== null && Number(override) !== suggestion,
    onChange,
    reset,
    adopt,
  };
}
