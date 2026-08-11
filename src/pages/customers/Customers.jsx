import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchCustomers } from "../../services/customerService";
import "./Customers.css";

export default function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchCustomers();
      setCustomers(data);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load customers.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="customers__state">Loading…</div>;

  const q = search.trim().toLowerCase();
  const visible = q
    ? customers.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.phone || "").includes(q) ||
          (c.address || "").toLowerCase().includes(q)
      )
    : customers;

  return (
    <div className="customers">
      <div className="customers__head">
        <h1 className="customers__title">Customers</h1>
        <span className="customers__count">{customers.length}</span>
        <button
          className="customers__addpast"
          onClick={() => navigate("/customers/add-past")}
        >
          + Add past jobs
        </button>
      </div>

      {error && <p className="customers__error">{error}</p>}

      <input
        className="customers__search"
        type="search"
        placeholder="Search by name, phone, or address…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {visible.length === 0 ? (
        <p className="customers__empty">
          {q ? "No customers match your search." : "No customers yet."}
        </p>
      ) : (
        <div className="customers__list">
          {visible.map((c) => (
            <div
              className="custrow"
              key={c.id}
              onClick={() => navigate(`/customers/${c.id}`)}
              role="button"
              tabIndex={0}
            >
              <div className="custrow__main">
                <span className="custrow__name">{c.name}</span>
                <span className="custrow__meta">
                  {c.phone || "No phone"}
                  {c.address ? ` · ${c.address}` : ""}
                </span>
              </div>
              <span className="custrow__arrow">›</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}