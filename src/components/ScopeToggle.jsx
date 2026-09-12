import { SCOPES, rememberScope } from "./scopeMemory";
import "./ScopeToggle.css";

/**
 * Mine / All, for the two lead lists.
 *
 * "Mine" is leads you added — created_by — because that is the only
 * ownership a lead has. There is no assignment on a lead, only on the job
 * it eventually becomes.
 *
 * Why it defaults to Mine even for an owner: on a board of everyone's work
 * the question "what should I do next" is buried, and that is the question
 * the pipeline exists to answer. All is one tap away and the choice sticks,
 * so anyone who thinks in terms of the whole team sets it once.
 *
 * Worth being clear about what this is NOT. It is a filter, not a boundary.
 * `leads` has no row-level security, so every role can still fetch every
 * lead — this changes what the page asks for, not what the database is
 * willing to hand over.
 *
 * TWO THINGS HERE ARE ABOUT NOT COLLIDING WITH THE VIEW SWITCHER, which
 * sits directly above it on both pages.
 *
 * The second option is "Everyone", not "All leads" — the switcher already
 * has a tab called All leads, and two stacked pill rows both offering
 * "All leads" made the page unreadable. They mean different things
 * (Pipeline vs All leads is which STAGES; Mine vs Everyone is whose), so
 * they must not share a word.
 *
 * And it carries no count. The line it sits on already says "12 active",
 * which is the count of exactly what this filter is showing.
 */

const LABELS = { mine: "Mine", all: "Everyone" };

export default function ScopeToggle({ scope, onChange }) {
  function pick(next) {
    if (next === scope) return;
    rememberScope(next);
    onChange(next);
  }

  return (
    <div className="scope" role="group" aria-label="Whose leads to show">
      {SCOPES.map((key) => (
        <button
          key={key}
          type="button"
          className={`scope__btn ${scope === key ? "scope__btn--on" : ""}`}
          aria-pressed={scope === key}
          onClick={() => pick(key)}
        >
          {LABELS[key]}
        </button>
      ))}
    </div>
  );
}
