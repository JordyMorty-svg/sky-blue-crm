import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import CustomerHeader from "../../components/CustomerHeader";
import RecordTabs from "../../components/RecordTabs";
import { fetchCustomer } from "../../services/customerService";
import "./Customers.css";

/*
 * One customer, three tabs, one header.
 *
 * WHAT THIS FIXES. Customer info, Quotes and Communication were three
 * independent pages that each drew the header and each fetched the
 * customer. Switching tabs therefore tore the whole record down and built
 * it again: the name blinked out, the badges re-flowed, and the lead-source
 * chip changed between tabs because the two pages had drifted into drawing
 * it slightly differently. Three round trips for one customer, and a flash
 * every time.
 *
 * Now the record loads once here and stays mounted. React Router swaps only
 * what is inside <Outlet />, so pressing a tab changes the part below the
 * strip and nothing above it moves — which is what a tab is supposed to
 * mean.
 *
 * ---------------------------------------------------------------------------
 * HOW THE ACTIVE TAB TALKS BACK
 * ---------------------------------------------------------------------------
 *
 * The header and the tabs live up here, but two of their behaviours belong
 * to the tab underneath: the customer page's edit form has to be openable
 * from the Actions menu, and while it is open the tabs hide and "back"
 * means "put the form away".
 *
 * Two mechanisms, chosen to be boring:
 *
 *   REFS for the callbacks (openEditRef, cancelEditRef). A child writes to
 *   them in an effect with no dependency array, so they are always current
 *   and writing to them never re-renders this component. A callback in
 *   state would re-render the whole record on every keystroke in the child.
 *
 *   STATE for the two things that genuinely change what is drawn — whether
 *   the tabs show, and what the back link says. Primitives only, set from
 *   an effect keyed on the child's own boolean, so it fires when the mode
 *   flips and not otherwise. An object of functions here is how this kind
 *   of layout turns into an infinite render loop.
 */
export default function CustomerLayout() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /* Which tab is current, read from the URL rather than announced by the
     child. A child that announces itself can be wrong, and the way it goes
     wrong is a new tab added without the announcement — which highlights
     nothing and reads as a broken strip. The URL already knows. */
  const active = pathname.endsWith("/quotes")
    ? "quotes"
    : pathname.endsWith("/communication")
      ? "communication"
      : "info";

  const [customer, setCustomer] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // What the active tab has asked the chrome to do. Defaults are the
  // ordinary case; only the customer page's edit form changes them.
  const [chrome, setChrome] = useState({ hideTabs: false, backLabel: null });

  const openEditRef = useRef(null);
  const cancelEditRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { customer: row, jobs: rows } = await fetchCustomer(id);
      setCustomer(row);
      setJobs(rows || []);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // A tab that unmounts must not leave its chrome behind. Without this,
  // opening the edit form and then pressing Quotes from the Actions menu
  // would land on a Quotes tab with no tab strip and a back link offering
  // to cancel an edit that no longer exists.
  useEffect(() => {
    return () => setChrome({ hideTabs: false, backLabel: null });
  }, [id]);

  if (loading) return <div className="customers__state">Loading…</div>;
  if (!customer) {
    return <div className="customers__state">{error || "Customer not found."}</div>;
  }

  return (
    <div className="custdetail">
      <CustomerHeader
        customer={customer}
        onEdit={() => {
          // The customer page owns the form. From a sub-tab there is no
          // form to open, so go to the tab that has one and tell it to
          // open on arrival — the same trick Actions → Send a quote uses.
          if (openEditRef.current) openEditRef.current();
          else navigate(`/customers/${id}`, { state: { edit: true } });
        }}
        back={
          chrome.backLabel
            ? { label: chrome.backLabel, onClick: () => cancelEditRef.current?.() }
            : null
        }
      />

      {!chrome.hideTabs && (
        <RecordTabs
          base={`/customers/${id}`}
          active={active}
          infoLabel="Customer info"
        />
      )}

      {error && <p className="customers__error">{error}</p>}

      <Outlet
        context={{
          customer,
          jobs,
          reload: load,
          setChrome,
          openEditRef,
          cancelEditRef,
        }}
      />
    </div>
  );
}
