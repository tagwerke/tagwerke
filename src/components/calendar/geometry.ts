// Pure geometry for the hand-rolled time grid: clock-time <-> pixels and overlap-column
// layout. No React, no store — just math, so it's trivially testable and reused by the
// pointer/drag layer in a later phase. Times are ISO datetime strings read as local
// wall-clock (single-timezone instance), so we parse HH:MM straight off the string rather
// than constructing Dates (avoids any UTC drift).

export const HOUR_PX = 48; // one hour's height in the grid
export const PX_PER_MIN = HOUR_PX / 60;
export const MIN_EVENT_MIN = 15; // floor so a short/zero-length event stays visible
export const DAY_MINUTES = 24 * 60;

/** Minutes since local midnight for an ISO datetime ('...THH:MM...'). */
export function minsOfClock(iso: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** The 'YYYY-MM-DD' day an ISO datetime falls on. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export interface LaidOut {
  id: string;
  topPx: number;
  heightPx: number;
  leftPct: number; // 0..100 within the day column
  widthPct: number;
}

interface Span {
  id: string;
  s: number; // start minute
  e: number; // end minute (>= s + MIN_EVENT_MIN)
}

/**
 * Position a single day's timed events. Overlapping events split the column into
 * side-by-side lanes (Google-style): cluster events that transitively overlap, then greedy
 * interval-graph color each cluster into the fewest lanes.
 */
export function layoutDay(events: { id: string; start: string; end: string }[]): LaidOut[] {
  const spans: Span[] = events
    .map((ev) => {
      const s = minsOfClock(ev.start);
      return { id: ev.id, s, e: Math.max(minsOfClock(ev.end), s + MIN_EVENT_MIN) };
    })
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const out: LaidOut[] = [];
  let cluster: Span[] = [];
  let clusterEnd = -1;

  const flush = () => {
    const laneEnds: number[] = []; // lane index -> last assigned end minute
    const laneOf = new Map<string, number>();
    for (const sp of cluster) {
      let lane = laneEnds.findIndex((end) => end <= sp.s);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(sp.e);
      } else {
        laneEnds[lane] = sp.e;
      }
      laneOf.set(sp.id, lane);
    }
    const lanes = laneEnds.length || 1;
    for (const sp of cluster) {
      const lane = laneOf.get(sp.id) ?? 0;
      out.push({
        id: sp.id,
        topPx: sp.s * PX_PER_MIN,
        heightPx: (sp.e - sp.s) * PX_PER_MIN,
        leftPct: (lane / lanes) * 100,
        widthPct: (1 / lanes) * 100,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const sp of spans) {
    if (cluster.length && sp.s >= clusterEnd) flush(); // no overlap with current cluster
    cluster.push(sp);
    clusterEnd = Math.max(clusterEnd, sp.e);
  }
  if (cluster.length) flush();
  return out;
}

/** Human 'H:MM' for a minute-of-day (tooltips, labels). */
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
