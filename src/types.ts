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
}

export interface Task {
  id: ID;
  homeTabId: ID;
  text: string;
  date?: string;
  priority?: 1 | 2 | 3;
  owner?: string;
  done?: boolean;
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
