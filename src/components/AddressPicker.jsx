import { useState, useEffect, useId, useRef, useCallback } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import "./AddressPicker.css";

/**
 * Address autocomplete using the NEW Places API classes
 * (AutocompleteSuggestion + Place), required for new Google Cloud projects.
 * Renders our own input + suggestions dropdown.
 *
 * onChange({ address, latitude, longitude }) when a suggestion is picked.
 * onTextChange(text) as the user types.
 *
 * ---------------------------------------------------------------------------
 * Why the typing is throttled
 * ---------------------------------------------------------------------------
 *
 * This used to call Google on every keystroke, starting at one character. A
 * rep typing "1014 NE Diane Pl" at a door sent seventeen billable autocomplete
 * requests where four would do, and a single character matches most of the
 * country so the first few were never useful anyway.
 *
 * Nothing broke, which is what makes it worth a comment: the only symptom of
 * that bug is a bill. Sky Blue is well inside Google's free allowance either
 * way, so this is not a fix for a problem that was hurting — it is one that
 * stops the cost scaling with the number of leads knocked.
 *
 * The same reasoning as the session token below: both exist because Google
 * charges for something you cannot see happening.
 */

// Three characters before asking, and a quarter-second of quiet after the
// last one. Long enough to collapse a burst of typing into one request,
// short enough that the list still feels like it is keeping up.
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
export default function AddressPicker({
  value,
  onChange,
  onTextChange,
  placeholder = "Start typing an address…",
  // Lets a host page keep its own field styling. LeadDetail's inputs are
  // .detail__input and the map modal's are .modal__input; without this the
  // picker would arrive looking like a different app's control.
  inputClassName = "addresspicker__input",
}) {
  const placesLib = useMapsLibrary("places");
  const [inputValue, setInputValue] = useState(value || "");
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  // Which row the keyboard is on. -1 is "none", which is what Enter needs to
  // see so that Enter on a half-typed address still submits the form instead
  // of being swallowed by a list nobody is navigating.
  const [active, setActive] = useState(-1);
  const listId = useId();
  const sessionTokenRef = useRef(null);
  const containerRef = useRef(null);
  const timerRef = useRef(null);
  // Read inside the debounced callback rather than captured in its closure:
  // the library can finish loading between a keystroke and the request it
  // schedules, and a stale closure would skip that first real search.
  const libRef = useRef(null);
  // Guards against out-of-order replies. On a phone in a driveway a slow
  // response for "1014 N" can land after a fast one for "1014 NE Diane" and
  // replace the right suggestions with stale ones.
  const seqRef = useRef(0);

  // Create a session token once the library is ready (and after each select).
  useEffect(() => {
    libRef.current = placesLib ?? null;
    if (placesLib && !sessionTokenRef.current) {
      sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
    }
  }, [placesLib]);

  // A pending request must not fire after the form has gone.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const fetchSuggestions = useCallback((text) => {
    // Any keystroke cancels the request the previous one was about to make.
    clearTimeout(timerRef.current);

    if (text.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    timerRef.current = setTimeout(async () => {
      const lib = libRef.current;
      if (!lib) return;

      if (!sessionTokenRef.current) {
        sessionTokenRef.current = new lib.AutocompleteSessionToken();
      }

      const mine = ++seqRef.current;
      try {
        const request = {
          input: text,
          sessionToken: sessionTokenRef.current,
          includedRegionCodes: ["us"],
        };
        const { suggestions: results } =
          await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);

        // A slower earlier request must not overwrite a newer answer.
        if (mine !== seqRef.current) return;

        setSuggestions(results || []);
        setActive(-1);
        setOpen((results || []).length > 0);
      } catch (err) {
        if (mine !== seqRef.current) return;
        console.error("Autocomplete error:", err);
        setSuggestions([]);
        setOpen(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      // Only swallowed when a row is highlighted — see `active` above.
      if (active >= 0) {
        e.preventDefault();
        handleSelect(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function handleInput(e) {
    const text = e.target.value;
    setInputValue(text);
    onTextChange?.(text);
    fetchSuggestions(text);
  }

  async function handleSelect(suggestion) {
    try {
      const prediction = suggestion.placePrediction;
      const place = prediction.toPlace();
      await place.fetchFields({
        fields: ["formattedAddress", "location"],
      });

      const address = place.formattedAddress || prediction.text?.text || "";
      const latitude = place.location?.lat();
      const longitude = place.location?.lng();

      setInputValue(address);
      setSuggestions([]);
      setOpen(false);
      // Start a fresh session token for the next search.
      if (placesLib) {
        sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
      }
      onChange({ address, latitude, longitude });
    } catch (err) {
      console.error("Place details error:", err);
    }
  }

  return (
    <div className="addresspicker" ref={containerRef}>
      <input
        className={inputClassName}
        value={inputValue}
        onChange={handleInput}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      />
      {open && suggestions.length > 0 && (
        <ul className="addresspicker__menu" id={listId} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={i}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`addresspicker__option ${
                i === active ? "addresspicker__option--active" : ""
              }`}
              // Stays onClick rather than onMouseDown: there is no blur
              // handler racing it here (outside clicks are caught on
              // document), and onClick is the one that has been working on
              // the phones this is used from.
              onClick={() => handleSelect(s)}
              onMouseEnter={() => setActive(i)}
            >
              {s.placePrediction?.text?.text || "Unknown"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}