import { useLocation, useNavigate } from "react-router-dom";
import RecordMenu from "./RecordMenu";
import { planFor, formatPhone } from "../services/leadService";
import { callThroughQuo } from "../services/quoDial";
import "../pages/customers/Customers.css";

/*
 * Who this customer is, on every tab of their record.
 *
 * WHY IT IS A COMPONENT AND NOT THREE COPIES. Customer info, Quotes and
 * Communication are three real URLs, and they used to draw three different
 * headers: the main page had the name, the badge, the Actions menu and the
 * contact details; the other two had the name and a "← Back to customer"
 * link. Moving between them felt like leaving the customer and arriving
 * somewhere related, which is what the tab strip is supposed to stop.
 *
 * Now the top of the record is identical on all three and only the part
 * below the tabs changes. The back link is gone with it — "Customer info"
 * is a tab, and a Back button that goes where a tab already goes is a
 * second way to do one thing.
 *
 * EDIT IS A PROP, not a route. On the info tab it opens the edit modal in
 * place. The other two tabs have no modal, so they hand over a function
 * that navigates to the info tab with `state.edit` set and lets it open
 * there — the same trick "Send a quote" already uses with `state.send`.
 */
export default function CustomerHeader({ customer, onEdit, back = null }) {
  const navigate = useNavigate();

  /* WHERE "BACK" GOES, and the same answer on all three tabs.
   *
   * It used to live only on the customer's own page: the sub-tabs offered
   * "← Back to customer" instead, which now does what the tab strip does.
   * So three tabs of one record had two different ideas of what back meant,
   * and one of them led nowhere useful.
   *
   * state.from is set by whatever sent you here — a job, the schedule — and
   * RecordTabs carries it between tabs, so arriving at Communication from a
   * job still offers the job. Falling back to the list is right for the
   * ordinary case of opening a customer from the customer list.
   *
   * `back` overrides it. CustomerDetail passes one while its edit form is
   * open, where back means "put the form away", not "leave the customer".
   */
  const { state } = useLocation();
  const returnTo = state?.from || "/customers";
  const returnLabel = returnTo.startsWith("/jobs")
    ? "← Back to job"
    : returnTo.startsWith("/schedule")
      ? "← Back to schedule"
      : "← Back to customers";
  const id = customer.id;
  const propertyType = customer.property_type || "residential";
  const plan = planFor(customer.service_plan);
  const isRecurring = Boolean(plan) && customer.service_plan !== "one_time";

  return (
    <>
      <button
        className="custdetail__back"
        onClick={() =>
          back ? back.onClick() : navigate(returnTo, { state: state?.fromState })
        }
      >
        {back ? back.label : returnLabel}
      </button>

    <div className="custdetail__namerow">
      {/* The type badge lives INSIDE the heading, not beside it.
          A sibling would be a flex item next to a name that carries
          `flex: 1 1 200px` — the name would grow and shove the badge to
          the far side of the row, which is the disconnected look this
          move was meant to fix. In the text flow it stays glued to the
          last word however the name wraps. */}
      <h1 className="custdetail__name">
        {customer.name}
        {/* A real space, not just a margin. When a long commercial
            name fills the last line the badge drops to the next one,
            and a left margin would indent it there; a space collapses
            at the start of a line, so it lands flush under the name. */}
        {" "}
        <span
          className={`custbadge custbadge--${propertyType} custdetail__typebadge`}
        >
          {propertyType === "commercial" ? "Commercial" : "Residential"}
        </span>
      </h1>
      {/* One control where there were four.
          
          Three buttons plus the panel's own "Send a quote" made the top
          of the page read as a toolbar rather than as a customer, and
          on a phone they took a line of their own. A menu costs one tap
          to reach any of them and gives the name back its row. */}
      <RecordMenu
        label="Actions"
        items={[
          {
            label: "Schedule a job",
            tone: "primary",
            onSelect: () => navigate(`/customers/${id}/schedule`),
          },
          {
            // Quotes have their own page now, so this navigates rather
            // than opening a modal in place — and carries `send: true`
            // so the modal opens on arrival. Without that, moving
            // quotes off this page would have turned a one-tap action
            // into three: open the menu, land on a page, find the
            // button.
            label: "Send a quote",
            onSelect: () =>
              navigate(`/customers/${id}/quotes`, { state: { send: true } }),
          },
          {
            label: "History",
            onSelect: () =>
              navigate(`/history/customer/${id}`, {
                state: {
                  from: `/customers/${id}`,
                  person: { name: customer.name, phone: customer.phone },
                },
              }),
          },
          { label: "Edit", onSelect: () => onEdit?.() },
        ]}
      />
    </div>

    {/* Rendered only when there IS one. An always-present wrapper
        would keep its bottom margin on a one-time customer and leave a
        gap where the property badge used to be. The recurring label
        stays on its own line rather than joining the name: it is a
        sentence ("Recurring client · Quarterly"), not a one-word tag,
        and two badges after a long name crowd it at phone width. */}
    {isRecurring && (
      <div className="custdetail__badges">
        <span className="custbadge custbadge--recurring">
          Recurring client · {plan.label}
        </span>
      </div>
    )}

    {/* ONE LINE, NOT A STACK. The phone was a big blue link and the email
        a smaller grey span underneath it, so two facts of the same kind sat
        at two sizes with an uneven gap between them. They read as a pair
        now, separated by a dot, wrapping only when there is no room. */}
    <div className="custdetail__info">
      {customer.phone && (
        /* A BUTTON, NOT AN <a href="openphone://">. The deep link opens
           the Quo app, which is a phone app — on a laptop it was a dead
           click with no feedback at all. callThroughQuo picks the route
           this device actually has: the app on a phone, clipboard plus the
           web dialler anywhere else. See src/services/quoDial.js.

           Pressing it logs NOTHING. The call is written down when Quo says
           it happened, on the call.completed webhook. */
        <button
          type="button"
          className="custdetail__phone"
          onClick={() => void callThroughQuo(customer.phone)}
        >
          {formatPhone(customer.phone)}
        </button>
      )}
      {customer.phone && customer.email && (
        <span className="custdetail__dot" aria-hidden="true">·</span>
      )}
      {customer.email && (
        <a className="custdetail__email" href={`mailto:${customer.email}`}>
          {customer.email}
        </a>
      )}
    </div>
    </>
  );
}
