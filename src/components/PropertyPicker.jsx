import { useEffect, useRef, useState } from "react";
import AddressPicker from "./AddressPicker";
import {
  createProperty,
  fetchProperties,
  propertyName,
} from "../services/propertyService";
import "./PropertyPicker.css";

/**
 * Which building is this job at?
 *
 * The customer who prompted this had a model home being remodelled and the
 * house they actually live in. One person, one phone number, one invoice
 * trail, two buildings — and until db/properties.sql there was nowhere to
 * put the second address except over the top of the first.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * Almost every customer has one address and will forever. For them this
 * control must be a line of text that confirms where the van is going and
 * asks nothing — a dropdown with one option in it is a question with one
 * answer, and a form full of those is how people learn to stop reading.
 *
 * It only becomes a choice when there is genuinely a choice to make. One
 * property: a sentence, plus a quiet way in. Two or more: radios, because
 * the whole set is three words wide and a <select> hides the thing being
 * decided behind a tap.
 *
 * ---------------------------------------------------------------------------
 * WHY ADDING SAVES TO THE CUSTOMER RATHER THAN THE JOB
 * ---------------------------------------------------------------------------
 *
 * A second address is almost never a one-off. The reason it exists is that
 * somebody owns two buildings, and the next time they call it will be about
 * one of them. Writing it onto the job would mean retyping it every booking
 * and would leave the recurring-plan screens with nothing to point at.
 *
 * The cost is that a typo'd address becomes a permanent entry on a customer
 * rather than a mistake on one job — which is why it can be edited and
 * archived on the customer's profile.
 *
 * Props:
 *   customerId  — whose properties to offer. Null disables the control.
 *   value       — the selected property id, or null for "not chosen yet".
 *   onChange    — (propertyId, property) when the selection changes.
 *   disabled    — a finished job. The address is frozen; see jobAddress.js.
 *   fallback    — what to show when the customer has no properties at all,
 *                 normally the address off the lead. Display only.
 */
export default function PropertyPicker({
  customerId,
  value,
  onChange,
  disabled = false,
  fallback = "",
}) {
  // ONE PIECE OF STATE CARRYING WHOSE ADDRESSES THESE ARE.
  //
  // Not `properties` plus a separate `loading` flag: those two can disagree,
  // and the way they disagree is that the previous customer's addresses are
  // on screen, not loading, under the new customer's name. On a booking
  // screen that means dispatching a van to a stranger's house.
  //
  // Pinning the rows to the customer they came from makes "loading" a thing
  // that is derived rather than remembered, so it cannot be stale.
  const [data, setData] = useState({ forCustomer: null, rows: [] });
  const [error, setError] = useState("");

  const loading = Boolean(customerId) && data.forCustomer !== customerId;
  const properties = data.forCustomer === customerId ? data.rows : [];

  // The "add a different address" sub-form. Collapsed until asked for: it
  // is two fields almost nobody needs, and open by default it reads as
  // something you are supposed to fill in.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", address: "", latitude: null, longitude: null });
  const [saving, setSaving] = useState(false);

  // REFS, NOT DEPENDENCIES, and this is not a lint workaround.
  //
  // The fetch below needs to know what is currently selected (so it only
  // pre-selects when nothing is) and needs to call back to report that.
  // Listing either in the effect's dependencies makes it re-run whenever
  // the selection changes — so choosing the second property refetches the
  // list, and an onChange the host re-creates each render refetches on
  // every keystroke anywhere on the booking form.
  //
  // What should re-run this is the customer changing. That is the only
  // dependency.
  // Written in an effect of their own rather than during render, which
  // React forbids: a render can be thrown away and re-run, and a ref
  // mutated on the discarded pass would carry a value no committed render
  // ever had.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!customerId) return undefined;

    let cancelled = false;

    (async () => {
      try {
        const rows = await fetchProperties(customerId);
        // The customer changed while this was in flight.
        if (cancelled) return;

        setData({ forCustomer: customerId, rows });
        setError("");

        // PRE-SELECT THE PRIMARY, but only when nothing is chosen yet.
        // Re-selecting unconditionally would stamp on a choice somebody
        // made thirty seconds ago every time this remounted — which the
        // schedule screen does when the date changes.
        if (!valueRef.current && rows.length > 0) {
          const primary = rows.find((p) => p.is_primary) ?? rows[0];
          onChangeRef.current?.(primary.id, primary);
        }
      } catch (e) {
        console.error(e);
        if (cancelled) return;
        // NOT FATAL, and deliberately still marks the fetch as done for
        // this customer. The booking screens have to keep working against
        // a database that has not run db/properties.sql yet; without this
        // the page sits on "Loading addresses…" forever and nobody can
        // schedule anything at all.
        setData({ forCustomer: customerId, rows: [] });
        setError("Couldn't load this customer's addresses.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [customerId]);

  async function saveNew(e) {
    e.preventDefault();
    if (!draft.address.trim() || saving) return;

    setSaving(true);
    try {
      const created = await createProperty(customerId, draft);
      setData((cur) => ({ ...cur, rows: [...cur.rows, created] }));
      // Select it immediately. Somebody who just typed an address is
      // booking a job at it; making them then pick it from a list is the
      // kind of step that feels like the software not paying attention.
      onChange?.(created.id, created);
      setAdding(false);
      setDraft({ label: "", address: "", latitude: null, longitude: null });
      setError("");
    } catch (err) {
      console.error(err);
      setError(err.message || "Couldn't save that address.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="proppick__muted">Loading addresses…</p>;

  // A FINISHED JOB SAYS WHY, rather than showing a dead control. The host
  // screen renders the frozen address itself; all this has to do is explain
  // the absence, because a missing control with no explanation reads as a
  // page that failed to load.
  if (disabled) {
    return (
      <p className="proppick__muted">
        This job is finished, so its address is fixed at where the work was done.
      </p>
    );
  }

  // No properties on file — a lead-only job, or a database mid-migration.
  if (properties.length === 0) {
    return (
      <div className="proppick">
        <p className="proppick__muted">
          {fallback ? fallback : "No address on file."}
        </p>
        {error && <p className="proppick__error">{error}</p>}
      </div>
    );
  }

  const only = properties.length === 1 ? properties[0] : null;

  return (
    <div className="proppick">
      {only ? (
        // ONE ADDRESS: a statement, not a question.
        <p className="proppick__single">{propertyName(only)}</p>
      ) : (
        <ul className="proppick__list">
          {properties.map((p) => (
            <li key={p.id}>
              <label className="proppick__option">
                <input
                  type="radio"
                  name="property"
                  checked={value === p.id}
                  onChange={() => onChange?.(p.id, p)}
                />
                <span className="proppick__optiontext">
                  {p.label && <strong>{p.label}</strong>}
                  <span>{p.address}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        // NOT A <form>. This renders inside the schedule screen's own form,
        // and a nested one is invalid HTML that browsers resolve by
        // dropping it — at which point this Save button submits the booking
        // instead, creating a job at the address the customer had before.
        <div className="proppick__add">
          <label className="proppick__label">Address</label>
          <AddressPicker
            value={draft.address}
            inputClassName="proppick__input"
            onChange={({ address, latitude, longitude }) =>
              setDraft((d) => ({ ...d, address, latitude, longitude }))
            }
            onTextChange={(text) =>
              // Coordinates cleared, not kept. A half-edited address with
              // the previous pin still attached is the one case where the
              // map confidently sends the van to the wrong house.
              setDraft((d) => ({ ...d, address: text, latitude: null, longitude: null }))
            }
          />

          <label className="proppick__label">
            Name it <span className="proppick__hint">optional</span>
          </label>
          <input
            className="proppick__input"
            value={draft.label}
            placeholder="Main house, model home, the rental…"
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />

          <div className="proppick__actions">
            <button
              type="button"
              className="proppick__save"
              onClick={saveNew}
              disabled={!draft.address.trim() || saving}
            >
              {saving ? "Saving…" : "Save address"}
            </button>
            <button
              type="button"
              className="proppick__cancel"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>

          <p className="proppick__note">
            Saved to this customer, so you can pick it again next time.
          </p>
        </div>
      ) : (
        <button type="button" className="proppick__addlink" onClick={() => setAdding(true)}>
          + Different address
        </button>
      )}

      {error && <p className="proppick__error">{error}</p>}
    </div>
  );
}
