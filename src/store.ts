import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Filter, ID, PlannerMode, Project, RootState, Tab, Task, TaskStatus, TimeBlock } from './types';
import { nextColor } from './util/color';
import { todayISO } from './util/dates';
import { api, enqueue } from './api/client';

function nextPosition(orders: number[]): number {
  return orders.length ? Math.max(...orders) + 1 : 0;
}

interface Actions {
  createProject(name: string, color?: string): Project;
  renameProject(id: ID, name: string): void;
  recolorProject(id: ID, color: string): void;
  deleteProject(id: ID): void;

  createTab(projectId: ID, name: string): Tab;
  renameTab(id: ID, name: string): void;
  setTabLocation(id: ID, location: string): void;
  setTabStarred(id: ID, starred: boolean): void;
  setTabDoc(id: ID, doc: unknown): void;
  deleteTab(id: ID): void;
  setActiveTab(id: ID | null): void;

  upsertTask(t: Partial<Task> & { id: ID; homeTabId: ID; text: string }): Task;
  setTaskMeta(id: ID, meta: Partial<Pick<Task, 'date' | 'priority' | 'owner' | 'done' | 'status' | 'assigneeId' | 'position'>>): void;
  setTaskText(id: ID, text: string): void;
  setTaskStatus(id: ID, status: TaskStatus): void;
  setTaskAssignee(id: ID, assigneeId: ID | undefined): void;
  toggleTaskDone(id: ID): void;
  deleteTask(id: ID): void;
  deleteOrphanTasks(homeTabId: ID, keepIds: Set<ID>): void;

  // Planner — personal time blocks that reference a tab (own blocks only; teammates'
  // blocks are view-local). See src/components/planner.
  setOwnTimeBlocks(blocks: TimeBlock[]): void;
  createTimeBlock(input: { userId: ID; tabId: ID; date: string; start?: string | null; end?: string | null }): TimeBlock;
  updateTimeBlock(id: ID, patch: Partial<Omit<TimeBlock, 'id' | 'userId'>>): void;
  deleteTimeBlock(id: ID): void;
  reorderTimeBlocks(date: string, order: ID[]): void;
  setPlannerOpen(open: boolean): void;
  setPlannerDate(date: string): void;
  setPlannerMode(mode: PlannerMode): void;

  setFilter(patch: Partial<Filter>): void;
  resetFilter(): void;

  cleanupEmptyTasks(): number;

  hydrate(state: RootState): void;

  reset(): void;
}

interface DocLike { type: string; text?: string; attrs?: Record<string, unknown>; content?: DocLike[] }

const initialFilter: Filter = {
  projectIds: [],
  owners: [],
  priorities: [],
  hasDate: false,
  dueSoon: false,
  query: '',
};

function makeInitial(): RootState {
  const defaultProjectId = nanoid();
  const personalProjectId = nanoid();
  const sampleTabId = nanoid();
  const personalTabId = nanoid();

  const projects: Record<ID, Project> = {
    [defaultProjectId]: { id: defaultProjectId, name: 'Work', color: '#7c3aed', order: 0 },
    [personalProjectId]: { id: personalProjectId, name: 'Personal', color: '#0ea5e9', order: 1 },
  };

  const sample: Tab = {
    id: sampleTabId,
    projectId: defaultProjectId,
    name: 'Inbox',
    order: 0,
    starred: true,
    type: 'normal',
    docJSON: undefined,
  };

  const personal: Tab = {
    id: personalTabId,
    projectId: personalProjectId,
    name: 'Errands',
    order: 1,
    starred: false,
    type: 'normal',
    docJSON: undefined,
  };

  return {
    projects,
    tabs: { [sampleTabId]: sample, [personalTabId]: personal },
    tasks: {},
    timeBlocks: {},
    membersByBoard: {},
    projectOrder: [defaultProjectId, personalProjectId],
    tabOrder: [sampleTabId, personalTabId],
    starredRowOrder: [sampleTabId],
    activeTabId: null,
    plannerOpen: false,
    plannerDate: todayISO(),
    plannerMode: 'day',
    filter: initialFilter,
  };
}

export const useStore = create<RootState & Actions>()((set, get) => {
  // Patch one task in place, no-op if it no longer exists.
  const patchTask = (id: ID, patch: Partial<Task>) =>
    set((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...patch } } } : s));

  return {
      ...makeInitial(),

      createProject(name, color) {
        const id = nanoid();
        const used = Object.values(get().projects).map((p) => p.color);
        const position = nextPosition(Object.values(get().projects).map((p) => p.order));
        const project: Project = { id, name, color: color ?? nextColor(used), order: position };
        set((s) => ({
          projects: { ...s.projects, [id]: project },
          projectOrder: [...s.projectOrder, id],
        }));
        enqueue(() => api.projects.create({ id, name: project.name, color: project.color, position }));
        return project;
      },
      renameProject(id, name) {
        set((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], name } } }));
        enqueue(() => api.projects.update(id, { name }));
      },
      recolorProject(id, color) {
        set((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], color } } }));
        enqueue(() => api.projects.update(id, { color }));
      },
      deleteProject(id) {
        const canDelete = get().projectOrder.length > 1;
        set((s) => {
          if (s.projectOrder.length <= 1) return s;
          const fallbackProjectId = s.projectOrder.find((pid) => pid !== id);
          if (!fallbackProjectId) return s;

          const projects = { ...s.projects };
          delete projects[id];

          const tabs = { ...s.tabs };
          const tabsToDelete: ID[] = [];
          for (const t of Object.values(s.tabs)) {
            if (t.projectId !== id) continue;
            tabsToDelete.push(t.id);
            delete tabs[t.id];
          }

          const tasks = { ...s.tasks };
          for (const tid of tabsToDelete) {
            for (const task of Object.values(tasks)) {
              if (task.homeTabId === tid) delete tasks[task.id];
            }
          }
          return {
            projects,
            tabs,
            tasks,
            projectOrder: s.projectOrder.filter((pid) => pid !== id),
            tabOrder: s.tabOrder.filter((tid) => !tabsToDelete.includes(tid)),
            starredRowOrder: s.starredRowOrder.filter((tid) => !tabsToDelete.includes(tid)),
            activeTabId: s.activeTabId && tabsToDelete.includes(s.activeTabId) ? null : s.activeTabId,
          };
        });
        if (canDelete) enqueue(() => api.projects.remove(id));
      },

      createTab(projectId, name) {
        const id = nanoid();
        const position = nextPosition(Object.values(get().tabs).map((t) => t.order));
        const tab: Tab = {
          id, projectId, name, order: position, starred: false, type: 'normal',
        };
        set((s) => ({
          tabs: { ...s.tabs, [id]: tab },
          tabOrder: [...s.tabOrder, id],
        }));
        enqueue(() => api.tabs.create({ id, projectId, name, position, starred: false, type: 'normal' }));
        return tab;
      },
      renameTab(id, name) {
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], name } } }));
        enqueue(() => api.tabs.update(id, { name }));
      },
      setTabLocation(id, location) {
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], location } } }));
        enqueue(() => api.tabs.update(id, { location }));
      },
      setTabStarred(id, starred) {
        set((s) => {
          const star = starred
            ? Array.from(new Set([...s.starredRowOrder, id]))
            : s.starredRowOrder.filter((tid) => tid !== id);
          return {
            tabs: { ...s.tabs, [id]: { ...s.tabs[id], starred } },
            starredRowOrder: star,
          };
        });
        const starredPosition = starred ? get().starredRowOrder.indexOf(id) : null;
        enqueue(() => api.tabs.update(id, { starred, starredPosition }));
      },
      setTabDoc(id, doc) {
        // docJSON is persisted by the subscription differ in src/api/persist.ts.
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], docJSON: doc } } }));
      },
      deleteTab(id) {
        set((s) => {
          const tabs = { ...s.tabs };
          delete tabs[id];
          const tasks = { ...s.tasks };
          for (const task of Object.values(tasks)) {
            if (task.homeTabId === id) delete tasks[task.id];
          }
          return {
            tabs,
            tasks,
            tabOrder: s.tabOrder.filter((tid) => tid !== id),
            starredRowOrder: s.starredRowOrder.filter((tid) => tid !== id),
            activeTabId: s.activeTabId === id ? null : s.activeTabId,
          };
        });
        enqueue(() => api.tabs.remove(id));
      },
      setActiveTab(id) {
        set({ activeTabId: id });
      },

      upsertTask({ id, homeTabId, text, ...meta }) {
        const existing = get().tasks[id];
        // Spread existing first so entity-only fields (status/assigneeId/position/timestamps)
        // are preserved — this is the intra-session clobber fix (SPEC §8). `done` is a derived
        // mirror of status, never an independent field.
        const status = meta.status ?? existing?.status ?? 'todo';
        const merged: Task = {
          ...existing,
          id,
          homeTabId,
          text,
          status,
          assigneeId: meta.assigneeId ?? existing?.assigneeId,
          date: meta.date ?? existing?.date,
          priority: meta.priority ?? existing?.priority,
          owner: meta.owner ?? existing?.owner,
          position: meta.position ?? existing?.position ?? 0,
          done: status === 'done',
        };
        set((s) => ({ tasks: { ...s.tasks, [id]: merged } }));
        return merged;
      },
      setTaskMeta(id, meta) {
        // Keep the derived `done` mirror in sync whenever status is set here.
        const patch = meta.status !== undefined ? { ...meta, done: meta.status === 'done' } : meta;
        patchTask(id, patch);
      },
      setTaskText(id, text) {
        patchTask(id, { text });
      },
      setTaskStatus(id, status) {
        patchTask(id, { status, done: status === 'done' });
      },
      setTaskAssignee(id, assigneeId) {
        patchTask(id, { assigneeId });
      },
      toggleTaskDone(id) {
        const t = get().tasks[id];
        if (!t) return;
        const next: TaskStatus = (t.status ?? 'todo') === 'done' ? 'todo' : 'done';
        patchTask(id, { status: next, done: next === 'done' });
      },
      deleteTask(id) {
        set((s) => {
          const tasks = { ...s.tasks };
          delete tasks[id];
          return { tasks };
        });
      },
      deleteOrphanTasks(homeTabId, keepIds) {
        set((s) => {
          const tasks: Record<ID, Task> = {};
          for (const t of Object.values(s.tasks)) {
            if (t.homeTabId !== homeTabId || keepIds.has(t.id)) tasks[t.id] = t;
          }
          return { tasks };
        });
      },

      setOwnTimeBlocks(blocks) {
        const map: Record<ID, TimeBlock> = {};
        for (const b of blocks) map[b.id] = b;
        set({ timeBlocks: map });
      },
      createTimeBlock(input) {
        const id = nanoid();
        const sameDay = Object.values(get().timeBlocks).filter((b) => b.date === input.date);
        const position = nextPosition(sameDay.map((b) => b.position));
        const block: TimeBlock = {
          id,
          userId: input.userId,
          tabId: input.tabId,
          date: input.date,
          start: input.start ?? null,
          end: input.end ?? null,
          label: null,
          filter: null,
          assigneeId: null,
          position,
        };
        set((s) => ({ timeBlocks: { ...s.timeBlocks, [id]: block } }));
        enqueue(() => api.timeBlocks.create(block));
        return block;
      },
      updateTimeBlock(id, patch) {
        set((s) => (s.timeBlocks[id] ? { timeBlocks: { ...s.timeBlocks, [id]: { ...s.timeBlocks[id], ...patch } } } : s));
        enqueue(() => api.timeBlocks.update(id, patch));
      },
      deleteTimeBlock(id) {
        set((s) => {
          const timeBlocks = { ...s.timeBlocks };
          delete timeBlocks[id];
          return { timeBlocks };
        });
        enqueue(() => api.timeBlocks.remove(id));
      },
      reorderTimeBlocks(date, order) {
        set((s) => {
          const timeBlocks = { ...s.timeBlocks };
          order.forEach((id, i) => {
            if (timeBlocks[id]?.date === date) timeBlocks[id] = { ...timeBlocks[id], position: i };
          });
          return { timeBlocks };
        });
        enqueue(() => api.timeBlocks.reorder(order));
      },
      setPlannerOpen(open) {
        set(open ? { plannerOpen: true, activeTabId: null } : { plannerOpen: false });
      },
      setPlannerDate(date) {
        set({ plannerDate: date });
      },
      setPlannerMode(mode) {
        set({ plannerMode: mode });
      },

      setFilter(patch) {
        set((s) => ({ filter: { ...s.filter, ...patch } }));
      },
      resetFilter() {
        set({ filter: initialFilter });
      },

      cleanupEmptyTasks() {
        const { tasks, tabs } = get();
        const emptyIds = new Set<ID>();
        for (const t of Object.values(tasks)) {
          if (!t.text || !t.text.trim()) emptyIds.add(t.id);
        }
        if (!emptyIds.size) return 0;

        const nextTasks: Record<ID, Task> = {};
        for (const t of Object.values(tasks)) {
          if (!emptyIds.has(t.id)) nextTasks[t.id] = t;
        }

        const nextTabs: Record<ID, Tab> = { ...tabs };
        for (const tab of Object.values(tabs)) {
          if (!tab.docJSON) continue;
          const cloned = JSON.parse(JSON.stringify(tab.docJSON)) as DocLike;
          let changed = false;
          const walk = (n: DocLike) => {
            if (!Array.isArray(n.content)) return;
            const filtered: DocLike[] = [];
            for (const child of n.content) {
              if (
                child.type === 'taskItem' &&
                typeof child.attrs?.id === 'string' &&
                emptyIds.has(child.attrs.id as ID)
              ) {
                changed = true;
                continue;
              }
              walk(child);
              filtered.push(child);
            }
            n.content = filtered;
          };
          walk(cloned);
          if (changed) nextTabs[tab.id] = { ...tab, docJSON: cloned };
        }

        set({ tasks: nextTasks, tabs: nextTabs });
        return emptyIds.size;
      },

      hydrate(state) {
        // The server's /api/state doesn't carry Planner state (blocks are lazy-fetched
        // per date window; the rest is local UI), so default it rather than clobber.
        set({
          ...state,
          timeBlocks: state.timeBlocks ?? {},
          plannerOpen: false,
          plannerDate: state.plannerDate ?? todayISO(),
          plannerMode: state.plannerMode ?? 'day',
        });
      },

      reset() {
        set(makeInitial());
      },
  };
});

export function useTab(id: ID | null | undefined) {
  return useStore((s) => (id ? s.tabs[id] : undefined));
}

export function useProject(id: ID | undefined) {
  return useStore((s) => (id ? s.projects[id] : undefined));
}

export function useTasksForTab(tabId: ID): Task[] {
  return useStore((s) => Object.values(s.tasks).filter((t) => t.homeTabId === tabId));
}

export function getTask(id: ID): Task | undefined {
  return useStore.getState().tasks[id];
}
