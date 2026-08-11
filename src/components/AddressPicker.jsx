import { useState, useEffect, useRef, useCallback } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import "./AddressPicker.css";

/**
 * Address autocomplete using the NEW Places API classes
 * (AutocompleteSuggestion + Place), required for new Google Cloud projects.
 * Renders our own input + suggestions dropdown.
 *
 * onChange({ address, latitude, longitude }) when a suggestion is picked.
 * onTextChange(text) as the user types.
 */
export default function AddressPicker({
  value,
  onChange,
  onTextChange,
  placeholder = "Start typing an address…",
}) {
  const placesLib = useMapsLibrary("places");
  const [inputValue, setInputValue] = useState(value || "");
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const sessionTokenRef = useRef(null);
  const containerRef = useRef(null);

  // Create a session token once the library is ready (and after each select).
  useEffect(() => {
    if (placesLib && !sessionTokenRef.current) {
      sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
    }
  }, [placesLib]);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const fetchSuggestions = useCallback(
    async (text) => {
      if (!placesLib || !text) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      try {
        const request = {
          input: text,
          sessionToken: sessionTokenRef.current,
          includedRegionCodes: ["us"],
        };
        const { suggestions: results } =
          await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
        setSuggestions(results || []);
        setOpen((results || []).length > 0);
      } catch (err) {
        console.error("Autocomplete error:", err);
        setSuggestions([]);
        setOpen(false);
      }
    },
    [placesLib]
  );

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
        className="addresspicker__input"
        value={inputValue}
        onChange={handleInput}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="addresspicker__menu">
          {suggestions.map((s, i) => (
            <li
              key={i}
              className="addresspicker__option"
              onClick={() => handleSelect(s)}
            >
              {s.placePrediction?.text?.text || "Unknown"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}