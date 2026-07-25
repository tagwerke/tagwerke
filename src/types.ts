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

/** The caller's role on a board (from board_members). Ranked viewer < editor < admin. */
export type BoardRole = 'viewer' | 'editor' | 'admin';

export interface Tab {
  id: ID;
  projectId: ID;
  name: string;
  order: number;
  starred: boolean;
  type: TabType;
  // The caller's OWN role on this board. Drives read-only vs editable UI (viewer = read-only doc).
  // Absent only transiently before the first /api/state load; treat missing as read-only-safe.
  role?: BoardRole;
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
  // Sub-task nesting (SUBTASKS_PLAN D1): the parent task id, or undefined for a top-level task.
  // Same-board only. The ROW owns the tree — the document references root tasks only, and a
  // parent's node view renders its subtree from these rows.
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
  // Sibling order within `parentTaskId` — a fractional index key compared lexicographically
  // (shared/rank.ts). ONE order for every view (SUBTASKS_PLAN D4). Absent only for a row written
  // before the backfill; `compareRank` sorts those last.
  rank?: string;
  /** @deprecated Superseded by `rank`. No longer written; removed in SUBTASKS_PLAN P7. */
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

// ── Notifications (per-user feed) ──────────────────────────────────────────
export type NotificationType = 'task_assigned' | 'review_requested' | 'task_approved' | 'board_added';

/** One row of the notification feed, as the server serializes it (ISO timestamps). */
export interface Notification {
  id: ID;
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Board to open when clicked; null for account-level events. */
  tabId?: ID | null;
  actorId?: ID | null;
  readAt?: string | null; // ISO; null = unread
  createdAt: string; // ISO
}

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
  /**
   * A parent was just marked done while sub-tasks were still open. Holds the offer to sweep them
   * too (SUBTASKS_PLAN D5) until the user accepts or declines. Never blocks the parent's own status
   * change — that has already been applied by the time this is set.
   */
  pendingCascade: { taskId: ID; count: number } | null;
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
