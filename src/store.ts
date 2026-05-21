import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { Filter, ID, Project, RootState, Snapshot, Tab, Task, TodayBlock } from './types';
import { nextColor } from './util/color';
import { todayISO } from './util/dates';

interface Actions {
  createProject(name: string, color?: string): Project;
  renameProject(id: ID, name: string): void;
  recolorProject(id: ID, color: string): void;
  deleteProject(id: ID): void;

  createTab(projectId: ID, name: string): Tab;
  renameTab(id: ID, name: string): void;
  setTabStarred(id: ID, starred: boolean): void;
  setTabDoc(id: ID, doc: unknown): void;
  deleteTab(id: ID): void;
  setActiveTab(id: ID | null): void;

  upsertTask(t: Partial<Task> & { id: ID; homeTabId: ID; text: string }): Task;
  setTaskMeta(id: ID, meta: Partial<Pick<Task, 'date' | 'priority' | 'owner' | 'done'>>): void;
  setTaskText(id: ID, text: string): void;
  toggleTaskDone(id: ID): void;
  deleteTask(id: ID): void;
  deleteOrphanTasks(homeTabId: ID, keepIds: Set<ID>): void;

  addBlock(after?: ID): TodayBlock;
  updateBlock(id: ID, patch: Partial<TodayBlock>): void;
  deleteBlock(id: ID): void;
  addTaskToBlock(blockId: ID, taskId: ID): void;
  removeTaskFromBlock(blockId: ID, taskId: ID): void;
  reorderBlocks(order: ID[]): void;

  setFilter(patch: Partial<Filter>): void;
  resetFilter(): void;

  freezeToday(): Snapshot | null;

  reset(): void;
}

const initialFilter: Filter = {
  projectIds: [],
  owners: [],
  priorities: [],
  hasDate: false,
  dueSoon: false,
  query: '',
};

function makeInitial(): RootState {
  const todayId = nanoid();
  const defaultProjectId = nanoid();
  const personalProjectId = nanoid();
  const sampleTabId = nanoid();
  const personalTabId = nanoid();

  const projects: Record<ID, Project> = {
    [defaultProjectId]: { id: defaultProjectId, name: 'Work', color: '#7c3aed', order: 0 },
    [personalProjectId]: { id: personalProjectId, name: 'Personal', color: '#0ea5e9', order: 1 },
  };

  const today: Tab = {
    id: todayId,
    projectId: defaultProjectId,
    name: 'TODAY',
    order: 0,
    starred: true,
    type: 'today',
    blocks: [],
    dateKey: todayISO(),
  };

  const sample: Tab = {
    id: sampleTabId,
    projectId: defaultProjectId,
    name: 'Inbox',
    order: 1,
    starred: true,
    type: 'normal',
    docJSON: undefined,
  };

  const personal: Tab = {
    id: personalTabId,
    projectId: personalProjectId,
    name: 'Errands',
    order: 2,
    starred: false,
    type: 'normal',
    docJSON: undefined,
  };

  return {
    projects,
    tabs: { [todayId]: today, [sampleTabId]: sample, [personalTabId]: personal },
    tasks: {},
    snapshots: {},
    projectOrder: [defaultProjectId, personalProjectId],
    tabOrder: [todayId, sampleTabId, personalTabId],
    starredRowOrder: [todayId, sampleTabId],
    todayTabId: todayId,
    activeTabId: null,
    filter: initialFilter,
  };
}

export const useStore = create<RootState & Actions>()(
  persist(
    (set, get) => ({
      ...makeInitial(),

      createProject(name, color) {
        const id = nanoid();
        const used = Object.values(get().projects).map((p) => p.color);
        const project: Project = { id, name, color: color ?? nextColor(used), order: get().projectOrder.length };
        set((s) => ({
          projects: { ...s.projects, [id]: project },
          projectOrder: [...s.projectOrder, id],
        }));
        return project;
      },
      renameProject(id, name) {
        set((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], name } } }));
      },
      recolorProject(id, color) {
        set((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], color } } }));
      },
      deleteProject(id) {
        set((s) => {
          const projects = { ...s.projects };
          delete projects[id];
          const tabsToDelete = Object.values(s.tabs).filter((t) => t.projectId === id).map((t) => t.id);
          const tabs = { ...s.tabs };
          tabsToDelete.forEach((tid) => delete tabs[tid]);
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
          };
        });
      },

      createTab(projectId, name) {
        const id = nanoid();
        const tab: Tab = {
          id, projectId, name, order: get().tabOrder.length, starred: false, type: 'normal',
        };
        set((s) => ({
          tabs: { ...s.tabs, [id]: tab },
          tabOrder: [...s.tabOrder, id],
        }));
        return tab;
      },
      renameTab(id, name) {
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], name } } }));
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
      },
      setTabDoc(id, doc) {
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], docJSON: doc } } }));
      },
      deleteTab(id) {
        set((s) => {
          if (s.tabs[id]?.type === 'today') return s;
          const tabs = { ...s.tabs };
          delete tabs[id];
          const tasks = { ...s.tasks };
          for (const task of Object.values(tasks)) {
            if (task.homeTabId === id) delete tasks[task.id];
          }
          const todayId = s.todayTabId;
          const today = s.tabs[todayId];
          const blocks = today?.blocks?.map((b) =>
            b.tabId === id ? { ...b, taskIds: [] } : { ...b, taskIds: b.taskIds.filter((t) => tasks[t]) }
          ).filter((b) => b.tabId !== id);
          return {
            tabs: {
              ...tabs,
              [todayId]: { ...tabs[todayId], blocks: blocks ?? [] },
            },
            tasks,
            tabOrder: s.tabOrder.filter((tid) => tid !== id),
            starredRowOrder: s.starredRowOrder.filter((tid) => tid !== id),
            activeTabId: s.activeTabId === id ? null : s.activeTabId,
          };
        });
      },
      setActiveTab(id) {
        set({ activeTabId: id });
      },

      upsertTask({ id, homeTabId, text, ...meta }) {
        const existing = get().tasks[id];
        const merged: Task = {
          id,
          homeTabId,
          text,
          date: meta.date ?? existing?.date,
          priority: meta.priority ?? existing?.priority,
          owner: meta.owner ?? existing?.owner,
          done: meta.done ?? existing?.done,
        };
        set((s) => ({ tasks: { ...s.tasks, [id]: merged } }));
        return merged;
      },
      setTaskMeta(id, meta) {
        set((s) => {
          if (!s.tasks[id]) return s;
          return { tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...meta } } };
        });
      },
      setTaskText(id, text) {
        set((s) => {
          if (!s.tasks[id]) return s;
          return { tasks: { ...s.tasks, [id]: { ...s.tasks[id], text } } };
        });
      },
      toggleTaskDone(id) {
        set((s) => {
          if (!s.tasks[id]) return s;
          return { tasks: { ...s.tasks, [id]: { ...s.tasks[id], done: !s.tasks[id].done } } };
        });
      },
      deleteTask(id) {
        set((s) => {
          const tasks = { ...s.tasks };
          delete tasks[id];
          const todayId = s.todayTabId;
          const today = s.tabs[todayId];
          const blocks = today?.blocks?.map((b) => ({ ...b, taskIds: b.taskIds.filter((t) => t !== id) })) ?? [];
          return { tasks, tabs: { ...s.tabs, [todayId]: { ...s.tabs[todayId], blocks } } };
        });
      },
      deleteOrphanTasks(homeTabId, keepIds) {
        set((s) => {
          const tasks: Record<ID, Task> = {};
          for (const t of Object.values(s.tasks)) {
            if (t.homeTabId !== homeTabId || keepIds.has(t.id)) tasks[t.id] = t;
          }
          const todayId = s.todayTabId;
          const today = s.tabs[todayId];
          const blocks = today?.blocks?.map((b) => ({ ...b, taskIds: b.taskIds.filter((tid) => tasks[tid]) })) ?? [];
          return { tasks, tabs: { ...s.tabs, [todayId]: { ...s.tabs[todayId], blocks } } };
        });
      },

      addBlock(after) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        if (!today) throw new Error('today not initialized');
        const firstNormal = Object.values(tabs).find((t) => t.type === 'normal');
        const block: TodayBlock = {
          id: nanoid(),
          tabId: firstNormal?.id ?? '',
          taskIds: [],
        };
        const blocks = today.blocks ? [...today.blocks] : [];
        if (after) {
          const idx = blocks.findIndex((b) => b.id === after);
          blocks.splice(idx + 1, 0, block);
        } else {
          blocks.push(block);
        }
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
        return block;
      },
      updateBlock(id, patch) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        const blocks = (today?.blocks ?? []).map((b) => (b.id === id ? { ...b, ...patch } : b));
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
      },
      deleteBlock(id) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        const blocks = (today?.blocks ?? []).filter((b) => b.id !== id);
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
      },
      addTaskToBlock(blockId, taskId) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        const blocks = (today?.blocks ?? []).map((b) =>
          b.id === blockId
            ? { ...b, taskIds: b.taskIds.includes(taskId) ? b.taskIds : [...b.taskIds, taskId] }
            : b
        );
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
      },
      removeTaskFromBlock(blockId, taskId) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        const blocks = (today?.blocks ?? []).map((b) =>
          b.id === blockId ? { ...b, taskIds: b.taskIds.filter((t) => t !== taskId) } : b
        );
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
      },
      reorderBlocks(order) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        if (!today?.blocks) return;
        const byId = new Map(today.blocks.map((b) => [b.id, b]));
        const blocks = order.map((id) => byId.get(id)!).filter(Boolean);
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
      },

      setFilter(patch) {
        set((s) => ({ filter: { ...s.filter, ...patch } }));
      },
      resetFilter() {
        set({ filter: initialFilter });
      },

      freezeToday() {
        const { todayTabId, tabs, tasks } = get();
        const today = tabs[todayTabId];
        if (!today?.blocks) return null;
        const lines: string[] = [];
        lines.push(`# ${today.dateKey ?? todayISO()}`);
        lines.push('');
        for (const block of today.blocks) {
          const tab = tabs[block.tabId];
          const range = block.start && block.end ? `${block.start}–${block.end}` : block.start ?? '';
          const header = [tab?.name ?? '(unbound)', range, block.label].filter(Boolean).join('  ');
          lines.push(`## ${header}`);
          for (const tid of block.taskIds) {
            const t = tasks[tid];
            if (!t) continue;
            const mark = t.done ? '[x]' : '[ ]';
            const chips = [
              t.priority ? '!'.repeat(t.priority) : '',
              t.owner ? `[${t.owner}]` : '',
              t.date ? `@${t.date}` : '',
            ].filter(Boolean).join(' ');
            lines.push(`- ${mark} ${t.text}${chips ? '  ' + chips : ''}`);
          }
          lines.push('');
        }
        const snap: Snapshot = {
          id: nanoid(),
          dateKey: today.dateKey ?? todayISO(),
          createdAt: Date.now(),
          text: lines.join('\n'),
        };
        set((s) => ({
          snapshots: { ...s.snapshots, [snap.id]: snap },
          tabs: {
            ...s.tabs,
            [todayTabId]: { ...s.tabs[todayTabId], blocks: [], dateKey: todayISO() },
          },
        }));
        return snap;
      },

      reset() {
        set(makeInitial());
      },
    }),
    {
      name: 'do-app/v1',
      version: 1,
    }
  )
);

export function useTodayTab() {
  return useStore((s) => s.tabs[s.todayTabId]);
}

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
