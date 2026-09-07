import ViewSwitcher from "../../components/ViewSwitcher";
import { CUSTOMER_VIEWS } from "../../components/navViews";
import FollowUpRunner from "../../components/FollowUpRunner";
import SendToCustomer from "../../components/SendToCustomer";
import "./Communication.css";

/**
 * What the CRM sends customers, and the controls for sending it.
 *
 * A sibling view of the customer list rather than a page of its own, because
 * it is the same section of the business seen from a different angle — you
 * come here to think about outreach, not to look someone up. It lived at the
 * bottom of the Income page first, which was worse in a way worth recording:
 * nobody navigates to Income to think about email, so nobody found it.
 *
 * Two panels, in the order you need them. The queue answers "is this
 * working and who is next"; sending to one person is the exception, and the
 * only way to see the email without waiting three days for the schedule.
 */
export default function Communication() {
  return (
    <div className="comms">
      <ViewSwitcher views={CUSTOMER_VIEWS} section="customers" />

      <header className="comms__head">
        <h1 className="comms__title">Communication</h1>
        <p className="comms__blurb">
          Everything the CRM sends customers on its own. Right now that&rsquo;s
          the review request that goes out three days after a job is finished.
        </p>
      </header>

      <div className="comms__panels">
        <FollowUpRunner />
        <SendToCustomer />
      </div>
    </div>
  );
}
