import { planFor } from "../services/leadService";
import "./JobPlanTag.css";

/**
 * Shows whether a job is part of a recurring plan or a one-off.
 *
 * Worth surfacing on every job list: a touch-up and a plan visit look
 * identical otherwise, but they behave differently — only a plan visit
 * moves the recurring clock forward.
 */
export default function JobPlanTag({ job }) {
  const plan = job?.service_plan || "one_time";

  // Checked before the plan, because an extra is stamped one_time and would
  // otherwise read as an ordinary single cleaning. For a customer on a plan
  // those are very different things: this one deliberately sits outside
  // their cycle and doesn't move their next visit.
  if (job?.is_extra) {
    return <span className="plantag plantag--extra">One-off extra</span>;
  }

  if (plan === "one_time") {
    return <span className="plantag plantag--onetime">One-time</span>;
  }

  const visit = job?.visit_number || 1;
  return (
    <span className="plantag plantag--plan">
      {planFor(plan).label}
      <span className="plantag__visit">visit {visit}</span>
    </span>
  );
}
