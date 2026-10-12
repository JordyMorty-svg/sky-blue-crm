import { useCallback, useEffect, useState } from "react";
import AddressPicker from "./AddressPicker";
import {
  archiveProperty,
  createProperty,
  fetchProperties,
  setPrimaryProperty,
  updateProperty,
} from "../services/propertyService";
import "./CustomerProperties.css";

/*
 * The buildings this customer wants cleaned.
 *
 * THE MISSING HALF of db/properties.sql. Addresses could already be ADDED,
 * from the booking screen and the quote modal, because that is where you
 * are standing when you discover there is a second house. Nothing could
 * rename one, change which is the default, or retire one — so a typo'd
 * address, or the model home after the remodel finished, was permanent.
 *
 * It replaces the single address line that used to sit under the phone
 * number. That line was honest when a customer had one address; with two it
 * showed whichever was on the customer record and gave no hint the other
 * existed.
 *
 * ARCHIVE, NOT DELETE, and the refusals come from propertyService:
 * the last address cannot be archived, and neither can the default while
 * another exists. Both would leave a customer whose next job quietly books
 * against the customer record instead of a building, with nothing on screen
 * saying so.
 */
export default function CustomerProperties({ customerId }) {
  // Rows pinned to the customer they came from, so "loading" is derived
  // rather than remembered — the same shape as PropertyPicker, and for the
  // same reason: a separate loading flag can disagree with the rows, and
  // the way it disagrees is one customer's addresses shown under another's
  // name.
  const [data, setData] = useState({ forCustomer: null, rows: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loading = Boolean(customerId) && data.forCustomer !== customerId;
  const rows = data.forCustomer === customerId ? data.rows : [];

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", address: "", latitude: null, longitude: null });

  // Which row is being renamed, and to what. One at a time: a list where
  // every row is an input is a form, and this is a list.
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState("");

  const load = useCallback(async () => {
    if (!customerId) return;
    try {
      setData({ forCustomer: customerId, rows: await fetchProperties(customerId) });
      setError("");
    } catch (e) {
      console.error(e);
      // NOT FATAL, and still marks the fetch as done for this customer.
      // The customer page has to keep working against a database that has
      // not run db/properties.sql yet; without the empty result it would
      // sit on "loading" forever and render nothing at all.
      setData({ forCustomer: customerId, rows: [] });
      setError("Couldn't load this customer's addresses.");
    }
  }, [customerId]);

  useEffect(() => {
    // Wrapped rather than `void load()`, matching LeadComms and
    // CustomerComms. The lint rule reads a bare call to a function that
    // setStates as a synchronous setState in an effect body; inside an
    // async IIFE the writes provably happen in a later tick, which is what
    // the rule is actually asking for.
    void (async () => {
      await load();
    })();
  }, [load]);

  // Every mutation goes through this: one busy flag, one error line, one
  // reload. Written once because four copies of try/catch/reload is four
  // places for the reload to be forgotten — and a list that does not
  // refresh after a change looks like a change that did not happen.
  async function run(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      console.error(e);
      setError(e.message || "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <section className="custprops">
      <div className="custprops__head">
        <span className="custprops__title">
          {rows.length > 1 ? "Addresses" : "Address"}
        </span>
        {!adding && (
          <button
            type="button"
            className="custprops__addlink"
            onClick={() => setAdding(true)}
          >
            + Add
          </button>
        )}
      </div>

      {rows.length === 0 && !adding && (
        <p className="custprops__empty">No address on file.</p>
      )}

      <ul className="custprops__list">
        {rows.map((p) => (
          <li key={p.id} className="custprops__item">
            <div className="custprops__main">
              {editingId === p.id ? (
                <div className="custprops__rename">
                  <input
                    className="custprops__input"
                    value={editLabel}
                    autoFocus
                    placeholder="Main house, model home, the rental…"
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter saves, Escape abandons. This sits inside the
                      // customer page; a bare input that swallows Enter is
                      // one somebody presses twice and then gives up on.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const value = editLabel;
                        setEditingId(null);
                        void run(() => updateProperty(p.id, { label: value }));
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button
                    type="button"
                    className="custprops__save"
                    onClick={() => {
                      const value = editLabel;
                      setEditingId(null);
                      void run(() => updateProperty(p.id, { label: value }));
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="custprops__cancel"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="custprops__label">
                    {p.label || "Unnamed"}
                    {p.is_primary && (
                      <span className="custprops__default">Default</span>
                    )}
                  </span>
                  <span className="custprops__address">{p.address}</span>
                </>
              )}
            </div>

            {editingId !== p.id && (
              <div className="custprops__actions">
                <button
                  type="button"
                  className="custprops__action"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(p.id);
                    setEditLabel(p.label || "");
                  }}
                >
                  Rename
                </button>
                {/* Offered only where it would do something. "Make default"
                    on the row that already is one is a button that reports
                    success and changes nothing. */}
                {!p.is_primary && (
                  <button
                    type="button"
                    className="custprops__action"
                    disabled={busy}
                    onClick={() => void run(() => setPrimaryProperty(p.id))}
                  >
                    Make default
                  </button>
                )}
                {/* Shown even when it will be refused, and the refusal says
                    why — "Archive" quietly missing from the last address is
                    a UI that looks broken; "This is the only address on
                    file" is one that explains itself. */}
                <button
                  type="button"
                  className="custprops__action custprops__action--quiet"
                  disabled={busy}
                  onClick={() => void run(() => archiveProperty(p.id))}
                >
                  Archive
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {adding && (
        <div className="custprops__add">
          <label className="custprops__fieldlabel">Address</label>
          <AddressPicker
            value={draft.address}
            inputClassName="custprops__input"
            onChange={({ address, latitude, longitude }) =>
              setDraft((d) => ({ ...d, address, latitude, longitude }))
            }
            onTextChange={(text) =>
              // Coordinates cleared, not kept. A half-edited address with
              // the previous pin attached is the one case where the map
              // confidently sends the van to the wrong house.
              setDraft((d) => ({ ...d, address: text, latitude: null, longitude: null }))
            }
          />

          <label className="custprops__fieldlabel">
            Name it <span className="custprops__hint">optional</span>
          </label>
          <input
            className="custprops__input"
            value={draft.label}
            placeholder="Main house, model home, the rental…"
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />

          <div className="custprops__addactions">
            <button
              type="button"
              className="custprops__save"
              disabled={!draft.address.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await createProperty(customerId, draft);
                  setAdding(false);
                  setDraft({ label: "", address: "", latitude: null, longitude: null });
                })
              }
            >
              {busy ? "Saving…" : "Add address"}
            </button>
            <button
              type="button"
              className="custprops__cancel"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="custprops__error">{error}</p>}
    </section>
  );
}
