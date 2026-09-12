import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/useAuth";
import {
  fetchCommissions,
  fetchMyRates,
  markCommissionsPaid,
  stateFor,
  summarise,
  subjectFor,
  money,
  shortDate,
  KIND_LABELS,
} from "../../services/commissionService";
import "./Commission.css";

/**
 * What you have earned, and — for an owner — what everyone has earned.
 *
 * One page, two audiences, because they are the same question asked from
 * two seats. A rep opens this to answer "how much have I made"; an owner
 * opens it to answer "what do I owe, and to whom". Splitting them into two
 * pages would mean two things to keep in step for no gain.
 *
 * The honesty rule runs through all of it: nothing is presented as money in
 * hand before the money is in hand. A quote is an estimate and says so, and
 * a lead nobody has priced yet shows a percentage and no figure at all —
 * because there is no figure, and making one up would be worse than a blank.
 */

function StateBadge({ state }) {
  return (
    <span className={`comm__badge comm__badge--${state.tone}`} title={state.note || ""}>
      {state.label}
    </span>
  );
}

function Row({ row, selectable, selected, onToggle }) {
  const state = stateFor(row);
  return (
    <li className={`comm__row comm__row--${state.tone}`}>
      {selectable && (
        <input
          type="checkbox"
          className="comm__check"
          checked={selected}
          onChange={() => onToggle(row.id)}
          aria-label={`Select ${subjectFor(row)}`}
        />
      )}

      <div className="comm__rowmain">
        <div className="comm__rowtop">
          <span className="comm__subject">{subjectFor(row)}</span>
          <StateBadge state={state} />
        </div>
        <div className="comm__rowsub">
          <span className="comm__kind">{KIND_LABELS[row.kind] || row.kind}</span>
          <span className="comm__dot">·</span>
          <span className="comm__rate">{Number(row.rate)}%</span>
          {row.job?.starts_at && (
            <>
              <span className="comm__dot">·</span>
              <span>{shortDate(row.job.starts_at)}</span>
            </>
          )}
          {row.paid_at && (
            <>
              <span className="comm__dot">·</span>
              <span>paid {shortDate(row.paid_at)}</span>
            </>
          )}
        </div>
      </div>

      {/* The whole point of the page, in one ternary. A row with no price
          behind it shows what you'd earn, not what you've earned. */}
      <div className="comm__amountwrap">
        {state.showMoney ? (
          <>
            <span className="comm__amount">{money(row.amount)}</span>
            {state.estimated && <span className="comm__est">estimated</span>}
          </>
        ) : (
          <span className="comm__pctonly" title={state.note}>
            {Number(row.rate)}% of the job
          </span>
        )}
      </div>
    </li>
  );
}

function Totals({ sum }) {
  return (
    <div className="comm__totals">
      <div className="comm__total">
        <span className="comm__totallabel">Estimated</span>
        <span className="comm__totalvalue comm__totalvalue--pending">
          {money(sum.estimated)}
        </span>
        <span className="comm__totalhint">
          Jobs still to finish or be paid for
        </span>
      </div>
      <div className="comm__total">
        <span className="comm__totallabel">Ready to pay</span>
        <span className="comm__totalvalue comm__totalvalue--payable">
          {money(sum.payable)}
        </span>
        <span className="comm__totalhint">Done, paid for, owed to you</span>
      </div>
      <div className="comm__total">
        <span className="comm__totallabel">Paid out</span>
        <span className="comm__totalvalue comm__totalvalue--paid">
          {money(sum.paid)}
        </span>
        <span className="comm__totalhint">Already in your pocket</span>
      </div>
    </div>
  );
}

// One rep, in the owner's list. Collapsed to a line of totals until you
// want the detail — an owner with six reps wants the shape of the payroll
// first and the line items second.
function RepCard({ rep, rows, open, onToggleOpen, selected, onToggleRow, onSelectAll }) {
  const sum = summarise(rows);
  const payableIds = rows
    .filter((r) => r.status === "payable")
    .map((r) => r.id);
  const allSelected =
    payableIds.length > 0 && payableIds.every((id) => selected.has(id));

  return (
    <section className="comm__rep">
      <button
        type="button"
        className="comm__rephead"
        onClick={onToggleOpen}
        aria-expanded={open}
      >
        <span className="comm__repname">
          {rep.full_name || "(unnamed)"}
          <span className="comm__reprole">{rep.role}</span>
        </span>
        <span className="comm__repsums">
          <span className="comm__repsum comm__repsum--pending">
            {money(sum.estimated)} est.
          </span>
          <span className="comm__repsum comm__repsum--payable">
            {money(sum.payable)} owed
          </span>
          <span className="comm__repsum comm__repsum--paid">
            {money(sum.paid)} paid
          </span>
        </span>
        <span className="comm__repchev">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <>
          {payableIds.length > 0 && (
            <div className="comm__selectall">
              <label>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onSelectAll(payableIds, !allSelected)}
                />
                Select everything owed ({money(sum.payable)})
              </label>
            </div>
          )}
          <ul className="comm__rows">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                selectable={row.status === "payable"}
                selected={selected.has(row.id)}
                onToggle={onToggleRow}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function Commission() {
  const { user, profile, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [rates, setRates] = useState(null);
  const [openRep, setOpenRep] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // `isAdmin` is in the deps for the same reason it is on the schedule and
  // the map: the profile lands a beat after the session, so a first fetch
  // keyed on nothing would run before we know whether to ask for one
  // person's rows or everyone's.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        // RLS already narrows a rep to their own rows. The explicit filter
        // is for an ADMIN looking at their own page — without it an owner
        // would see the whole company's ledger under "your earnings",
        // which is a different question.
        const [data, myRates] = await Promise.all([
          fetchCommissions(isAdmin ? {} : { profileId: user?.id }),
          // Only a rep needs these: an owner is commission_eligible = false,
          // so their own rates are all zero and the owner header never
          // quotes them. Nice-to-have either way — if it fails, the header
          // drops the sentence rather than the page failing to load.
          isAdmin ? Promise.resolve(null) : fetchMyRates().catch(() => null),
        ]);
        if (!cancelled) {
          setRows(data);
          setRates(myRates);
          setError("");
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load commissions.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isAdmin]);

  // An owner's own rows, if they somehow have any. Owners are
  // commission_eligible = false so this is normally empty, and the page
  // says so rather than showing three zeroes with no explanation.
  const byRep = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const id = row.profile?.id || "unknown";
      if (!map.has(id)) {
        map.set(id, { rep: row.profile || { full_name: "Unknown" }, rows: [] });
      }
      map.get(id).rows.push(row);
    }
    return [...map.values()].sort((a, b) =>
      (a.rep.full_name || "").localeCompare(b.rep.full_name || "")
    );
  }, [rows]);

  const mySum = useMemo(() => summarise(rows), [rows]);

  function toggleRow(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(ids, on) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function handleMarkPaid() {
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const ids = [...selected];
      const count = await markCommissionsPaid(ids);
      // Patch in place rather than refetching: the database stamps now(),
      // which is what this is, and a reload would scroll an owner back to
      // the top of a list they were working down.
      const stamp = new Date().toISOString();
      setRows((cur) =>
        cur.map((r) =>
          selected.has(r.id) && r.status === "payable"
            ? { ...r, status: "paid", paid_at: stamp }
            : r
        )
      );
      setSelected(new Set());
      setNotice(
        count === 1 ? "Marked 1 commission paid." : `Marked ${count} commissions paid.`
      );
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't mark those paid.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="comm__state">Loading…</p>;

  const selectedTotal = rows
    .filter((r) => selected.has(r.id))
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  return (
    <div className="comm">
      <header className="comm__head">
        <h1 className="comm__title">{isAdmin ? "Commission" : "Your commission"}</h1>
        <p className="comm__blurb">
          {isAdmin
            ? "What every rep has earned, and what's waiting to be paid out."
            : rates
              ? `You earn ${rates.find}% for finding a lead, ${rates.book}% for booking it, and ${rates.work}% for working the job. Nothing is payable until the customer has paid.`
              : "Nothing is payable until the customer has paid."}
        </p>
      </header>

      {error && <p className="comm__error">{error}</p>}
      {notice && <p className="comm__notice">{notice}</p>}

      {isAdmin ? (
        <>
          {selected.size > 0 && (
            <div className="comm__bar">
              <span className="comm__barcount">
                {selected.size} selected · {money(selectedTotal)}
              </span>
              <button
                type="button"
                className="comm__pay"
                onClick={handleMarkPaid}
                disabled={busy}
              >
                {busy ? "Marking…" : "Mark paid"}
              </button>
              <button
                type="button"
                className="comm__clear"
                onClick={() => setSelected(new Set())}
                disabled={busy}
              >
                Clear
              </button>
            </div>
          )}

          {byRep.length === 0 ? (
            <p className="comm__empty">
              Nobody has earned anything yet. Commission starts accruing the
              moment a rep adds a lead.
            </p>
          ) : (
            byRep.map(({ rep, rows: repRows }) => (
              <RepCard
                key={rep.id || rep.full_name}
                rep={rep}
                rows={repRows}
                open={openRep === (rep.id || rep.full_name)}
                onToggleOpen={() =>
                  setOpenRep((cur) =>
                    cur === (rep.id || rep.full_name) ? null : rep.id || rep.full_name
                  )
                }
                selected={selected}
                onToggleRow={toggleRow}
                onSelectAll={selectAll}
              />
            ))
          )}
        </>
      ) : (
        <>
          <Totals sum={mySum} />

          {mySum.unpriced > 0 && (
            <p className="comm__unpriced">
              {mySum.unpriced === 1
                ? "One lead hasn't been quoted yet, so there's no figure on it — you'll see one as soon as it's priced."
                : `${mySum.unpriced} leads haven't been quoted yet, so there are no figures on them — you'll see them as soon as they're priced.`}
            </p>
          )}

          {rows.length === 0 ? (
            <p className="comm__empty">
              Nothing yet. Add a lead and you'll see it here straight away —
              the percentage first, the figure once it's quoted.
            </p>
          ) : (
            <ul className="comm__rows comm__rows--mine">
              {rows.map((row) => (
                <Row key={row.id} row={row} selectable={false} selected={false} onToggle={() => {}} />
              ))}
            </ul>
          )}

          <p className="comm__foot">
            Signed in as {profile?.full_name || user?.email}. Questions about a
            figure go to Jordan or Hayden — this page reads the same ledger
            they pay from.
          </p>
        </>
      )}
    </div>
  );
}

