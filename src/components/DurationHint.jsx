import "./DurationHint.css";

/**
 * The line under the duration field that says where the number came from.
 *
 * An auto-filled value with no explanation is worse than an empty box: the
 * first thing anyone asks of a number a computer put there is "says who", and
 * a field that cannot answer gets overwritten out of suspicion — at which
 * point the whole feature is just a slower way of typing 3.
 *
 * So it always says one of three things:
 *   - the suggestion and the arithmetic behind it
 *   - that it is showing a value a person chose, with the way back
 *   - that it needs a price before it can help
 *
 * One component rather than five copies, because the five scheduling screens
 * drifting apart on this is exactly how `useState(3)` ended up in five files.
 */
export default function DurationHint({ isAuto, isOverridden, suggestion, explanation, onReset }) {
  if (isOverridden) {
    return (
      <p className="durationhint">
        <span className="durationhint__manual">Your estimate.</span> Suggested{" "}
        {suggestion} h —{" "}
        <button type="button" className="durationhint__reset" onClick={onReset}>
          use that instead
        </button>
      </p>
    );
  }

  if (!isAuto) {
    return <p className="durationhint">{explanation}</p>;
  }

  return (
    <p className="durationhint">
      <span className="durationhint__auto">Auto</span> {explanation}
    </p>
  );
}
