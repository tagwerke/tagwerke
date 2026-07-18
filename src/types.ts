export type ID = string;

export interface Project {
  id: ID;
  name: string;
  color: string;
  order: number;
}

// 'today' is retained transitionally so legacy today-tab rows (type='today') from
// before the Planner can still be classified and excluded from listings/pickers until
// they're removed by migration. New tabs are always 'normal'.
export type TabType = 'normal' | 'today';

/** Opt-in per-board guardrails (accountability model §F). Absent keys = off (flat/fast). */
export interface BoardSettings {
  requireReview?: boolean; // route Done through in_review; capture the approver
  restrictDelete?: 'admin'; // only board admins may delete content here
}

export interface Tab {
  id: ID;
  projectId: ID;
  name: string;
  order: number;
  starred: boolean;
  type: TabType;
  docJSON?: unknown;
  // Optimistic-concurrency counter for the shared document (live updates). Set from
  // /api/state and advanced by each doc save's response; sent back as baseVersion so a
  // stale save is rejected 409. See src/realtime/docSync.ts.
  docVersion?: number;
  location?: string; // board's place facet (v2)
  settings?: BoardSettings;
}

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';

export interface Task {
  id: ID;
  homeTabId: ID;
  // Sub-task nesting (TASKS_AS_ENTITIES.md, P2 node model): the parent task id, or undefined for a
  // top-level task. Same-board only. Set directly by Tab/Shift-Tab in the editor; the doc renders
  // indentation from it (the doc itself is a flat sequence of id-only task refs).
  parentTaskId?: ID;
  text: string;
  // P0: status is authoritative. Optional during the transition; slice 2 makes it required
  // and removes `done`. Treat a missing status as 'todo'.
  status?: TaskStatus;
  // P0: real user id of the assignee (a member of the home board). Supersedes `owner`.
  assigneeId?: ID;
  // Accountability chain (§F1): who signs off. approvedBy/approvedAt mirror the
  // in_review → done approval (DB-managed; read-only on the client).
  reviewerId?: ID;
  approvedBy?: ID;
  approvedAt?: number;
  date?: string;
  priority?: 1 | 2 | 3;
  position?: number;
  owner?: string; // legacy display fallback; superseded by assigneeId
  done?: boolean; // deprecated mirror of status==='done'; kept for one release
  createdAt?: number; // DB-managed; read-only on the client
  updatedAt?: number; // DB-managed; read-only on the client
}

/** A board member as the `@` picker / assignee chip needs them (no display name in the DB yet). */
export interface Member {
  id: ID;
  email: string;
  /** Email local-part, for display until a real display name exists. */
  name: string;
}

/**
 * Optional per-block projection filter. A block is already scoped to one tab, so
 * `projectIds`/`owners` from the full {@link Filter} are moot here — only these facets
 * narrow the live task list a block shows.
 */
export interface BlockFilter {
  priorities?: (1 | 2 | 3)[];
  statuses?: TaskStatus[];
  hasDate?: boolean;
  dueSoon?: boolean;
  query?: string;
}

export type PlannerMode = 'day' | 'week';

// ── Calendar (events model) ────────────────────────────────────────────────
export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needs-action';

export interface EventAttendance {
  userId: ID;
  status: RsvpStatus;
}

/** One instance of an event (a recurring event has one per occurrence date). */
export interface EventOccurrence {
  date: string; // 'YYYY-MM-DD'
  attendance: EventAttendance[];
}

/**
 * A calendar event / meeting. `tabId` null = a board-less 1:1 (owner-only). When set, the
 * event is a project meeting and `filter` narrows the board's live-task agenda. Times are
 * ISO datetime strings interpreted as the instance's local wall-clock (single-timezone).
 * `occurrences` is a read decoration from the window read, not a stored column.
 */
export interface CalendarEvent {
  id: ID;
  tabId?: ID | null;
  title?: string | null;
  start: string | null;
  end: string | null;
  allDay?: boolean;
  filter?: BlockFilter | null;
  rrule?: string | null;
  createdBy?: ID | null;
  occurrences?: EventOccurrence[];
}

/** Which view an open board renders. All read the same task entities. */
export type BoardView = 'doc' | 'list' | 'kanban' | 'calendar';

export interface RootState {
  projects: Record<ID, Project>;
  tabs: Record<ID, Tab>;
  tasks: Record<ID, Task>;
  /** Calendar events visible in the current window (member boards + own board-less). */
  events: Record<ID, CalendarEvent>;
  /** Per-board member rosters (the `@` picker's source). Keyed by tab/board id. */
  membersByBoard: Record<ID, Member[]>;
  projectOrder: ID[];
  tabOrder: ID[];
  starredRowOrder: ID[];
  activeTabId: ID | null;
  /** Which view the open board renders (doc/list/kanban/calendar). */
  boardView: BoardView;
  /** Planner UI state. */
  plannerOpen: boolean;
  plannerDate: string; // 'YYYY-MM-DD' cursor
  plannerMode: PlannerMode;
  filter: Filter;
}

export interface Filter {
  projectIds: ID[];
  owners: string[];
  priorities: (1 | 2 | 3)[];
  hasDate: boolean;
  dueSoon: boolean;
  query: string;
}
