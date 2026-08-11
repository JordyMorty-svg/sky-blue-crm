import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { addPastJobs } from "../../services/customerService";
import AddressPicker from "../../components/AddressPicker";
import "./AddPastJobs.css";

const METHODS = ["cash", "check", "card", "square"];

function emptyRow() {
  return {
    name: "",
    phone: "",
    address: "",
    latitude: null,
    longitude: null,
    date: "",
    time: "09:00",
    amount: "",
    method: "cash",
    interior: false,
    notes: "",
  };
}

export default function AddPastJobs() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([emptyRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function updateRow(i, field, value) {
    setRows((cur) =>
      cur.map((r, idx) => (idx === i ? { ...r, [field]: value } : r))
    );
  }

  function addRow() {
    setRows((cur) => [...cur, emptyRow()]);
  }

  function removeRow(i) {
    setRows((cur) => cur.filter((_, idx) => idx !== i));
  }

  async function handleSubmit() {
    setError("");
    // Keep only rows that have at least a name and an amount.
    const valid = rows.filter((r) => r.name.trim() && r.amount);
    if (valid.length === 0) {
      setError("Add at least one row with a name and an amount.");
      return;
    }

    setSaving(true);
    try {
      const count = await addPastJobs(valid);
      navigate("/customers", { state: { added: count } });
    } catch (e) {
      console.error(e);
      setError("Couldn't save. Check the rows and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="pastjobs">
      <button className="pastjobs__back" onClick={() => navigate("/customers")}>
        ← Back to customers
      </button>

      <h1 className="pastjobs__title">Add past jobs</h1>
      <p className="pastjobs__sub">
        Log completed jobs from before the CRM. Each row creates (or links) a
        customer and records a paid, completed job. No lead is created.
      </p>

      {error && <p className="pastjobs__error">{error}</p>}

      <div className="pastjobs__rows">
        {rows.map((row, i) => (
          <div className="pastrow" key={i}>
            <div className="pastrow__num">{i + 1}</div>
            <div className="pastrow__fields">
              <input
                className="pastrow__input"
                placeholder="Customer name"
                value={row.name}
                onChange={(e) => updateRow(i, "name", e.target.value)}
              />
              <input
                className="pastrow__input"
                placeholder="Phone"
                value={row.phone}
                onChange={(e) => updateRow(i, "phone", e.target.value)}
              />
              <div className="pastrow__addr">
                <AddressPicker
                  value={row.address}
                  onChange={({ address, latitude, longitude }) => {
                    setRows((cur) =>
                      cur.map((r, idx) =>
                        idx === i ? { ...r, address, latitude, longitude } : r
                      )
                    );
                  }}
                  onTextChange={(text) =>
                    setRows((cur) =>
                      cur.map((r, idx) =>
                        idx === i
                          ? { ...r, address: text, latitude: null, longitude: null }
                          : r
                      )
                    )
                  }
                  placeholder="Address"
                />
              </div>
              <input
                className="pastrow__input"
                type="date"
                value={row.date}
                onChange={(e) => updateRow(i, "date", e.target.value)}
              />
              <input
                className="pastrow__input pastrow__input--time"
                type="time"
                value={row.time}
                onChange={(e) => updateRow(i, "time", e.target.value)}
              />
              <input
                className="pastrow__input pastrow__input--amount"
                type="number"
                min="0"
                placeholder="$ amount"
                value={row.amount}
                onChange={(e) => updateRow(i, "amount", e.target.value)}
              />
              <select
                className="pastrow__input"
                value={row.method}
                onChange={(e) => updateRow(i, "method", e.target.value)}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
              <label className="pastrow__check">
                <input
                  type="checkbox"
                  checked={row.interior}
                  onChange={(e) => updateRow(i, "interior", e.target.checked)}
                />
                Interior
              </label>
              <input
                className="pastrow__input pastrow__input--wide"
                placeholder="Notes (optional)"
                value={row.notes}
                onChange={(e) => updateRow(i, "notes", e.target.value)}
              />
            </div>
            {rows.length > 1 && (
              <button
                className="pastrow__remove"
                onClick={() => removeRow(i)}
                aria-label="Remove row"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      <button className="pastjobs__addrow" onClick={addRow}>
        + Add another row
      </button>

      <div className="pastjobs__actions">
        <button
          className="pastjobs__submit"
          onClick={handleSubmit}
          disabled={saving}
        >
          {saving ? "Saving…" : `Save ${rows.filter((r) => r.name.trim() && r.amount).length} jobs`}
        </button>
        <button className="pastjobs__cancel" onClick={() => navigate("/customers")}>
          Cancel
        </button>
      </div>
    </div>
  );
}