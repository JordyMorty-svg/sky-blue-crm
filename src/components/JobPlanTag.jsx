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
