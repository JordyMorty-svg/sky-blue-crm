import { useState } from "react";
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
  // The two panels read the same customers, and the top one changes them:
  // a batch send stamps last_review_request_at, which is exactly what the
  // list below draws its "Email sent" badges from. Bumping a counter is
  // enough to make the list refetch — cheaper than lifting the customer
  // list into this page just so two siblings can share it.
  const [sentTick, setSentTick] = useState(0);

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
        <FollowUpRunner onSent={() => setSentTick((n) => n + 1)} />
        <SendToCustomer refreshKey={sentTick} />
      </div>
    </div>
  );
}
