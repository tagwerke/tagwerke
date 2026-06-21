import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Filter, ID, Project, RootState, Snapshot, Tab, Task, TodayBlock } from './types';
import { nextColor } from './util/color';
import { todayISO, toISO } from './util/dates';
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
  setTaskMeta(id: ID, meta: Partial<Pick<Task, 'date' | 'priority' | 'owner' | 'done'>>): void;
  setTaskText(id: ID, text: string): void;
  toggleTaskDone(id: ID): void;
  deleteTask(id: ID): void;
  deleteOrphanTasks(homeTabId: ID, keepIds: Set<ID>): void;
  /** Append a task (from an approved email draft) to a board's document. Returns
   *  the new task id. The node + store task share an id so the editor's SyncPlugin
   *  reconciles them instead of orphan-deleting. */
  appendTaskFromDraft(tabId: ID, fields: { text: string; date?: string | null; owner?: string | null }): ID;

  addBlock(after?: ID): TodayBlock;
  updateBlock(id: ID, patch: Partial<TodayBlock>): void;
  deleteBlock(id: ID): void;
  addTaskToBlock(blockId: ID, taskId: ID): void;
  removeTaskFromBlock(blockId: ID, taskId: ID): void;
  reorderBlocks(order: ID[]): void;

  setFilter(patch: Partial<Filter>): void;
  resetFilter(): void;

  freezeToday(): Snapshot | null;

  cleanupEmptyTasks(): number;

  hydrate(state: RootState): void;

  reset(): void;
}

interface DocLike { type: string; text?: string; attrs?: Record<string, unknown>; content?: DocLike[] }

function nodeText(n: DocLike | undefined): string {
  if (!n) return '';
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(nodeText).join('');
}

function renderTodayDocToText(doc: unknown, dateKey: string): string {
  const root = doc as DocLike | undefined;
  if (!root || !Array.isArray(root.content)) return '';
  const lines: string[] = [`# ${dateKey}`, ''];
  for (const top of root.content) {
    if (top.type === 'paragraph') {
      const text = nodeText(top);
      if (text.trim()) lines.push(text);
      else lines.push('');
      continue;
    }
    if (top.type === 'taskList') {
      for (const item of top.content ?? []) {
        if (item.type !== 'taskItem') continue;
        const done = item.attrs?.done ? '[x]' : '[ ]';
        const text = nodeText(item.content?.[0]);
        lines.push(`- ${done} ${text}`);
      }
      continue;
    }
    // Fallback for other top-level nodes (e.g. headings).
    const text = nodeText(top);
    if (text) lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

export const useStore = create<RootState & Actions>()((set, get) => {
  // Patch one task in place, no-op if it no longer exists.
  const patchTask = (id: ID, patch: Partial<Task>) =>
    set((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...patch } } } : s));

  // Replace the TODAY tab's blocks via a transform; everything else stays put.
  // Returns the new block list so callers can read positions back out.
  const mutateTodayBlocks = (transform: (blocks: TodayBlock[]) => TodayBlock[]): TodayBlock[] => {
    const { todayTabId, tabs } = get();
    const blocks = transform(tabs[todayTabId]?.blocks ?? []);
    set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...s.tabs[todayTabId], blocks } } }));
    return blocks;
  };

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
            if (t.type === 'today') {
              tabs[t.id] = { ...t, projectId: fallbackProjectId };
            } else {
              tabsToDelete.push(t.id);
              delete tabs[t.id];
            }
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
        const canDelete = get().tabs[id]?.type !== 'today';
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
        if (canDelete) enqueue(() => api.tabs.remove(id));
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
        patchTask(id, meta);
      },
      setTaskText(id, text) {
        patchTask(id, { text });
      },
      toggleTaskDone(id) {
        const t = get().tasks[id];
        if (t) patchTask(id, { done: !t.done });
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

      appendTaskFromDraft(tabId, fields) {
        // Match the editor's id format (SyncPlugin assigns nanoid(8)).
        const id = nanoid(8);
        const text = fields.text;
        const node = {
          type: 'taskItem',
          attrs: { id, done: false },
          content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
        };
        set((s) => {
          const tab = s.tabs[tabId];
          if (!tab) return s;
          const doc = tab.docJSON as { type?: string; content?: unknown[] } | undefined;
          const content = Array.isArray(doc?.content) ? [...doc.content] : [];
          const last = content.length ? (content[content.length - 1] as { type?: string; content?: unknown[] }) : null;
          if (last && last.type === 'taskList') {
            content[content.length - 1] = { ...last, content: [...(last.content ?? []), node] };
          } else {
            content.push({ type: 'taskList', content: [node] });
          }
          const newDoc = { ...(doc ?? {}), type: 'doc', content };
          // Seed store metadata too. Node text is plain, so when the board opens
          // the SyncPlugin falls back to these date/owner values (extractTokens
          // finds none) — keeping them consistent under the shared id.
          const task: Task = {
            id,
            homeTabId: tabId,
            text,
            date: fields.date ?? undefined,
            owner: fields.owner ?? undefined,
            done: false,
          };
          return {
            tabs: { ...s.tabs, [tabId]: { ...tab, docJSON: newDoc } },
            tasks: { ...s.tasks, [id]: task },
          };
        });
        return id;
      },

      addBlock(after) {
        const { todayTabId, tabs } = get();
        if (!tabs[todayTabId]) throw new Error('today not initialized');
        const firstNormal = Object.values(tabs).find((t) => t.type === 'normal');
        const block: TodayBlock = {
          id: nanoid(),
          tabId: firstNormal?.id ?? '',
          taskIds: [],
        };
        const blocks = mutateTodayBlocks((existing) => {
          const next = [...existing];
          if (after) {
            const idx = next.findIndex((b) => b.id === after);
            next.splice(idx + 1, 0, block);
          } else {
            next.push(block);
          }
          return next;
        });
        const position = blocks.findIndex((b) => b.id === block.id);
        enqueue(() => api.blocks.create({ id: block.id, homeTabId: block.tabId, position }));
        return block;
      },
      updateBlock(id, patch) {
        mutateTodayBlocks((blocks) => blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
        const apiPatch: { homeTabId?: ID; start?: string | null; end?: string | null; label?: string | null } = {};
        if (patch.tabId !== undefined) apiPatch.homeTabId = patch.tabId;
        if (patch.start !== undefined) apiPatch.start = patch.start ?? null;
        if (patch.end !== undefined) apiPatch.end = patch.end ?? null;
        if (patch.label !== undefined) apiPatch.label = patch.label ?? null;
        enqueue(() => api.blocks.update(id, apiPatch));
      },
      deleteBlock(id) {
        mutateTodayBlocks((blocks) => blocks.filter((b) => b.id !== id));
        enqueue(() => api.blocks.remove(id));
      },
      addTaskToBlock(blockId, taskId) {
        mutateTodayBlocks((blocks) => blocks.map((b) =>
          b.id === blockId
            ? { ...b, taskIds: b.taskIds.includes(taskId) ? b.taskIds : [...b.taskIds, taskId] }
            : b
        ));
        enqueue(() => api.blocks.addTask(blockId, taskId));
      },
      removeTaskFromBlock(blockId, taskId) {
        mutateTodayBlocks((blocks) => blocks.map((b) =>
          b.id === blockId ? { ...b, taskIds: b.taskIds.filter((t) => t !== taskId) } : b
        ));
        enqueue(() => api.blocks.removeTask(blockId, taskId));
      },
      reorderBlocks(order) {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        if (!today?.blocks) return;
        const byId = new Map(today.blocks.map((b) => [b.id, b]));
        const blocks = order.map((id) => byId.get(id)!).filter(Boolean);
        set((s) => ({ tabs: { ...s.tabs, [todayTabId]: { ...today, blocks } } }));
        enqueue(() => api.blocks.reorder(order));
      },

      setFilter(patch) {
        set((s) => ({ filter: { ...s.filter, ...patch } }));
      },
      resetFilter() {
        set({ filter: initialFilter });
      },

      freezeToday() {
        const { todayTabId, tabs } = get();
        const today = tabs[todayTabId];
        if (!today) return null;
        const frozenDateKey = today.dateKey ?? todayISO();
        const text = renderTodayDocToText(today.docJSON, frozenDateKey);
        if (!text.trim()) return null;
        const snap: Snapshot = {
          id: nanoid(),
          dateKey: frozenDateKey,
          createdAt: Date.now(),
          text,
        };
        const nextDate = new Date(frozenDateKey + 'T00:00:00');
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateKey = toISO(nextDate);
        set((s) => ({
          snapshots: { ...s.snapshots, [snap.id]: snap },
          tabs: {
            ...s.tabs,
            [todayTabId]: {
              ...s.tabs[todayTabId],
              docJSON: { type: 'doc', content: [{ type: 'paragraph' }] },
              blocks: [],
              dateKey: nextDateKey,
            },
          },
        }));
        // Server is authoritative for the freeze: it renders + stores the snapshot,
        // clears the today doc/blocks, and advances dateKey.
        enqueue(() => api.today.freeze({ snapshotId: snap.id, dateKey: frozenDateKey, docJSON: today.docJSON }));
        return snap;
      },

      cleanupEmptyTasks() {
        const { tasks, tabs, todayTabId } = get();
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

        const today = nextTabs[todayTabId];
        if (today?.blocks) {
          const blocks = today.blocks.map((b) => ({
            ...b,
            taskIds: b.taskIds.filter((id) => !emptyIds.has(id)),
          }));
          nextTabs[todayTabId] = { ...today, blocks };
        }

        set({ tasks: nextTasks, tabs: nextTabs });
        return emptyIds.size;
      },

      hydrate(state) {
        set(state);
      },

      reset() {
        set(makeInitial());
      },
  };
});

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
