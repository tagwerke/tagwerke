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

/**
 * A Planner time block. OWNED by `userId` (who scheduled it), REFERENCES a tab/board it
 * allocates time to — a live projection of that board's tasks, never a copy. Visible to
 * every member of `tabId`; only the owner edits it.
 */
export interface TimeBlock {
  id: ID;
  userId: ID;
  tabId: ID;
  date: string; // 'YYYY-MM-DD'
  start?: string | null; // 'HH:MM'
  end?: string | null;
  label?: string | null;
  filter?: BlockFilter | null;
  assigneeId?: ID | null;
  position: number;
}

export type PlannerMode = 'day' | 'week';

export interface RootState {
  projects: Record<ID, Project>;
  tabs: Record<ID, Tab>;
  tasks: Record<ID, Task>;
  /** The caller's OWN Planner blocks. Teammates' blocks live in PlannerView local state. */
  timeBlocks: Record<ID, TimeBlock>;
  /** Per-board member rosters (the `@` picker's source). Keyed by tab/board id. */
  membersByBoard: Record<ID, Member[]>;
  projectOrder: ID[];
  tabOrder: ID[];
  starredRowOrder: ID[];
  activeTabId: ID | null;
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
