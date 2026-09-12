// Which parts of the CRM each role is allowed to reach.
//
// Until recently `role` was decoration — the header printed it next to your
// name and nothing else read it. Every tab rendered for every signed-in
// user, which was fine while every signed-in user was Jordan or Hayden.
//
// READ THIS BEFORE RELYING ON IT: this is not security.
//
// The core tables (leads, jobs, customers) have no row-level security
// policies — only the append-only log tables do. Anyone with a login and the
// anon key can still read every row straight from PostgREST, whatever the
// nav shows. Hiding Income stops Income being *shown*; it does not stop the
// numbers being *fetched* by someone who goes looking. Making the boundary
// real means RLS policies, which is a separate and much more careful job.
// Until that exists, treat this file as role clarity, not as a wall.

// ---------------------------------------------------------------------------
// Why there are more keys here than there are tabs
// ---------------------------------------------------------------------------
//
// The first version of this gated whole sections, so taking Jobs away from a
// tech also took away /jobs/:id — and the calendar links straight there when
// you tap your own job (Schedule.jsx), as does "view record" after you
// finish one (CompleteJob.jsx). Same story for the map, whose customer pins
// open /customers/:id. A tech would have lost the ability to open the job
// they were standing in front of.
//
// So a list page and a detail page are separate permissions. "You may open
// the job you were sent to" and "you may browse every job we have" are
// genuinely different questions, and only the second one is a tab.

export const SECTIONS = [
  "leads", // the pipeline board, All leads, a lead's own page
  "jobs", // the Jobs tab: every job, scheduled and waiting
  "job-detail", // one job, opened from the schedule you're already on
  "schedule", // your day, the calendar, completing a job, the Square return
  "income", // the books
  "customers", // the customer list, Communication, Add past jobs
  "customer-detail", // one customer, opened from a map pin or a job
  "map",
  "commission", // what you've earned; for an owner, what everyone has earned
];

// Which sections get a tab in the top nav, in display order. A section not
// listed here is reachable but never advertised — that is the whole point of
// the detail keys.
export const NAV_SECTIONS = [
  "leads",
  "jobs",
  "schedule",
  "income",
  // Sits next to Income for an owner, because they are the two money pages
  // and you arrive at both asking the same sort of question. For a rep it
  // lands after Schedule, which is where their day ends.
  "commission",
  "customers",
  "map",
];

const ALLOWED = {
  // Owners. Everything, including the money and the destructive buttons.
  admin: SECTIONS,

  // Crew. Their leads, their day, the map, and the ability to open whatever
  // job or customer those pages point at — but not the master lists, and
  // not the books.
  tech: [
    "leads",
    "schedule",
    "map",
    "commission",
    "job-detail",
    "customer-detail",
  ],

  // A trade contact who sends work and occasionally swings a squeegee.
  // Has the map because that is where he adds a lead — standing outside a
  // house he has just quoted flooring for, dropping a pin is the whole
  // interaction. Still no customer pages: MapView hides customer pins from
  // anyone without `customer-detail`, so the map he sees is leads only.
  partner: ["leads", "schedule", "map", "commission", "job-detail"],
};

// Actions that are not places. Kept in the same file because "what may this
// role do" is one question, and splitting it across two modules is how the
// nav and the buttons drift apart.
const ACTIONS = {
  // Deleting a lead is a row leaving the database, and bulk delete can take
  // its jobs and its customer with it. Owners only — a mis-tap by someone
  // learning the CRM is not recoverable from the UI.
  delete_leads: ["admin"],
  // The calendar shows the whole team by default. Anyone without this sees
  // only the jobs they are assigned to.
  see_all_jobs: ["admin"],
};

// What an unrecognised or missing role gets.
//
// Deliberately `tech` rather than nothing. `role` is null whenever the
// profiles row is missing or its fetch errored, and a hard denial there
// would bounce that user off every route in turn — a redirect loop instead
// of a page, triggered by a dropped request. Falling back to tech keeps a
// real person working in the field while withholding the sections that
// would actually matter to leak, and an admin who lands here notices
// immediately because Income has vanished and a reload fixes it.
//
// Fail-open in the strict sense, but the strict sense is already lost: with
// no RLS behind it, a stricter default here would buy nothing but lockouts.
const FALLBACK_ROLE = "tech";

function allowedFor(role) {
  return ALLOWED[role] || ALLOWED[FALLBACK_ROLE];
}

// Can this role reach this section?
export function canSee(role, section) {
  return allowedFor(role).includes(section);
}

// May this role perform this action? Unknown actions are refused rather than
// allowed, so a typo'd capability name fails visibly instead of silently
// granting everyone everything.
export function can(role, action) {
  const roles = ACTIONS[action];
  if (!roles) return false;
  return roles.includes(role || FALLBACK_ROLE);
}

// The nav tabs this role should see, as section keys in display order.
export function navSectionsFor(role) {
  return NAV_SECTIONS.filter((section) => canSee(role, section));
}

// The lead source to preselect for this role.
//
// A partner's leads all arrive the same way — he saw the windows while he
// was in the house quoting floors — so making him pick "Partner referral"
// out of a list of nine every single time is a tax with one right answer.
// It stays a dropdown, because he might genuinely knock a door.
//
// Returns null for everyone else, which lets createLead's own "door"
// fallback stand rather than duplicating that default in two places.
export function defaultSourceFor(role) {
  return role === "partner" ? "partner" : null;
}

// The commission a rep earns on a lead they source, as a percent, or null
// if they earn nothing for finding. Read straight off the profile so the
// number a rep sees is the number the database will pay — a hardcoded 15
// here would go stale the day a rate changes.
export function findRateFor(profile) {
  if (!profile || profile.commission_eligible === false) return null;
  const rate = profile.commission_find_rate;
  return rate === null || rate === undefined ? null : Number(rate);
}

// Where to send someone who aimed at a section they can't have — their first
// permitted tab, so the answer is always somewhere they can actually use
// rather than a dead end. Falls back to /leads, which every role has.
export function landingFor(role) {
  return `/${navSectionsFor(role)[0] || "leads"}`;
}
