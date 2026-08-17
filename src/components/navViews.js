// View definitions for the in-page switchers.
//
// Kept out of the page components on purpose: exporting a non-component from
// a file that exports a component breaks React Fast Refresh (and trips
// react-refresh/only-export-components).
//
// `end` marks the index view so it isn't left highlighted when a sibling
// route is active.

// Two views of the same leads data: the working pipeline, and every lead
// ever. The map stays a top-level tab — it plots customers as well as
// leads, so it isn't a view of the leads pipeline.
export const LEAD_VIEWS = [
  { to: "/leads", label: "Pipeline", end: true },
  { to: "/leads/all", label: "All leads" },
];

// Your own day's jobs, versus the whole team's calendar.
export const SCHEDULE_VIEWS = [
  { to: "/schedule", label: "Daily", end: true },
  { to: "/schedule/calendar", label: "Calendar" },
];

// Booked leads waiting to be turned into jobs, versus jobs already on the
// calendar. Two different tasks rather than two filters of one list.
export const JOB_VIEWS = [
  { to: "/jobs", label: "To schedule", end: true },
  { to: "/jobs/scheduled", label: "Scheduled" },
];

// Sections whose last-used view is remembered across visits. `key` is the
// storage key; `root` is what the top nav highlights against.
export const REMEMBERED_SECTIONS = {
  leads: { root: "/leads", views: LEAD_VIEWS },
  jobs: { root: "/jobs", views: JOB_VIEWS },
  schedule: { root: "/schedule", views: SCHEDULE_VIEWS },
};
