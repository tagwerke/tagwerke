// Sprint week math (SPRINTS_PLAN.md). ONE function, used by both callers that need "this
// board's current calendar week" — server/routes/tabs.ts (new board → first sprint) and
// server/jobs/sprints.ts (weekly rollout) — so the week boundary is computed in exactly one
// place and the two can never disagree.
//
// Weeks are Monday–Sunday, anchored to a fixed IANA zone rather than the server's local time
// (a self-hosted instance's clock could be UTC, the operator's zone, anything). All arithmetic
// happens on the resulting Y-M-D calendar date via a UTC-anchored Date — never on `now` itself
// — so it is immune to the runtime's own local-timezone/DST quirks.

const WEEK_TZ = 'America/Toronto';

/** `now`'s calendar date in WEEK_TZ, as 'YYYY-MM-DD'. */
function localISODate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: WEEK_TZ }).format(now);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday .. 6 = Sunday, for an ISO 'YYYY-MM-DD' date. */
function isoWeekday(isoDate: string): number {
  const jsDay = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (jsDay + 6) % 7;
}

function shortLabel(isoDate: string): { month: string; day: number } {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(d);
  return { month, day: d.getUTCDate() };
}

export type WeekRange = { startsAt: string; endsAt: string; label: string };

/** The Monday–Sunday week (WEEK_TZ) containing `now`. */
export function currentWeekRange(now: Date): WeekRange {
  const today = localISODate(now);
  const startsAt = addDays(today, -isoWeekday(today));
  const endsAt = addDays(startsAt, 6);
  const start = shortLabel(startsAt);
  const end = shortLabel(endsAt);
  const label = start.month === end.month
    ? `${start.month} ${start.day}–${end.day}`
    : `${start.month} ${start.day} – ${end.month} ${end.day}`;
  return { startsAt, endsAt, label };
}
