export type ID = string;

export interface Project {
  id: ID;
  name: string;
  color: string;
  order: number;
}

export type TabType = 'normal' | 'today';

export interface Tab {
  id: ID;
  projectId: ID;
  name: string;
  order: number;
  starred: boolean;
  type: TabType;
  docJSON?: unknown;
  blocks?: TodayBlock[];
  dateKey?: string;
  location?: string; // board's place facet (v2)
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

export interface TodayBlock {
  id: ID;
  tabId: ID;
  start?: string;
  end?: string;
  taskIds: ID[];
  label?: string;
}

export interface Snapshot {
  id: ID;
  dateKey: string;
  createdAt: number;
  text: string;
}

export interface RootState {
  projects: Record<ID, Project>;
  tabs: Record<ID, Tab>;
  tasks: Record<ID, Task>;
  snapshots: Record<ID, Snapshot>;
  /** Per-board member rosters (the `@` picker's source). Keyed by tab/board id. */
  membersByBoard: Record<ID, Member[]>;
  projectOrder: ID[];
  tabOrder: ID[];
  starredRowOrder: ID[];
  todayTabId: ID;
  activeTabId: ID | null;
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
