import { create } from 'zustand';
import { useMemo } from 'react';
import { nanoid } from 'nanoid';
import type { BlockFilter, BoardSettings, BoardView, CalendarEvent, Filter, ID, PlannerMode, Project, RootState, RsvpStatus, Tab, Task, TaskStatus } from './types';
import { nextColor } from './util/color';
import { todayISO } from './util/dates';
import { dlog, sid } from './util/dlog';
import { api, enqueue } from './api/client';
import { compareRank, rankAfter, rankBetween } from '../shared/rank';
import { MAX_TASK_DEPTH } from '../shared/tree';

export function nextPosition(orders: number[]): number {
  return orders.length ? Math.max(...orders) + 1 : 0;
}

/** A task's siblings — same board, same parent — in rank order. The unit every reorder works over. */
export function siblingsOf(tasks: Record<ID, Task>, homeTabId: ID, parentTaskId: ID | undefined): Task[] {
  const key = parentTaskId ?? null;
  return Object.values(tasks)
    .filter((t) => t.homeTabId === homeTabId && (t.parentTaskId ?? null) === key)
    .sort(compareRank);
}

/** Append-position rank for a new task among its siblings (SUBTASKS_PLAN D4). */
function nextRank(tasks: Record<ID, Task>, homeTabId: ID, parentTaskId: ID | undefined): string {
  const ranked = siblingsOf(tasks, homeTabId, parentTaskId).filter((t) => t.rank);
  return rankAfter(ranked.length ? ranked[ranked.length - 1].rank : null);
}

/**
 * A board's tasks in depth-first OUTLINE order: parents before their children, siblings by rank.
 *
 * This is the board's one true order (SUBTASKS_PLAN D4). The doc renders it, List's outline mode
 * renders it, and each Kanban column sorts its own subset by it — which is what makes a family
 * cluster inside a column instead of scattering, without the column needing to know anything about
 * the tree. Returns an index map alongside the list so a filtered view can sort by `order.get(id)`.
 *
 * A child whose parent is missing from the board (trashed, or a dropped write) is treated as a
 * root rather than dropped — an orphan must still render somewhere. Genuine cycles are caught by
 * the `seen` guard and appended at the end.
 */
export function outlineOrder(tasks: Record<ID, Task>, tabId: ID): { list: Task[]; order: Map<ID, number> } {
  const mine = Object.values(tasks).filter((t) => t.homeTabId === tabId);
  const present = new Set(mine.map((t) => t.id));
  const byParent = new Map<ID | null, Task[]>();
  for (const t of mine) {
    // An unknown parent means "no parent here" — bucket the task as a root so it stays visible.
    const key = t.parentTaskId && present.has(t.parentTaskId) ? t.parentTaskId : null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort(compareRank);

  const out: Task[] = [];
  const seen = new Set<ID>();
  const walk = (parent: ID | null, depth: number): void => {
    if (depth > MAX_TASK_DEPTH + 1) return; // corruption guard; the server bounds real depth
    for (const t of byParent.get(parent) ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const t of mine) if (!seen.has(t.id)) out.push(t); // cycle survivors

  const order = new Map<ID, number>();
  out.forEach((t, i) => order.set(t.id, i));
  return { list: out, order };
}

/** How deeply `id` is nested (0 = a root). Walks ancestors; bounded, so a cycle can't hang it. */
export function taskDepth(tasks: Record<ID, Task>, id: ID): number {
  let depth = 0;
  let cur = tasks[id]?.parentTaskId;
  const seen = new Set<ID>([id]);
  while (cur && !seen.has(cur) && depth <= MAX_TASK_DEPTH + 1) {
    seen.add(cur);
    depth++;
    cur = tasks[cur]?.parentTaskId;
  }
  return depth;
}

/** Ancestors of `id`, nearest parent first. Powers the `Parent › Child` breadcrumb. */
export function ancestorsOf(tasks: Record<ID, Task>, id: ID): Task[] {
  const out: Task[] = [];
  const seen = new Set<ID>([id]);
  let cur = tasks[id]?.parentTaskId;
  while (cur && !seen.has(cur) && out.length <= MAX_TASK_DEPTH + 1) {
    seen.add(cur);
    const parent = tasks[cur];
    if (!parent) break;
    out.push(parent);
    cur = parent.parentTaskId;
  }
  return out;
}

/** Direct children of `id`, in rank order. */
export function childrenOf(tasks: Record<ID, Task>, id: ID): Task[] {
  return Object.values(tasks)
    .filter((t) => t.parentTaskId === id)
    .sort(compareRank);
}

/** Every descendant of `id` (children, grandchildren, …) in outline order. */
export function descendantsOf(tasks: Record<ID, Task>, id: ID): Task[] {
  const out: Task[] = [];
  const seen = new Set<ID>([id]);
  const walk = (parentId: ID, depth: number): void => {
    if (depth > MAX_TASK_DEPTH + 1) return;
    for (const child of childrenOf(tasks, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      walk(child.id, depth + 1);
    }
  };
  walk(id, 0);
  return out;
}

interface Actions {
  createProject(name: string, color?: string): Project;
  renameProject(id: ID, name: string): void;
  recolorProject(id: ID, color: string): void;
  deleteProject(id: ID): void;

  createTab(projectId: ID, name: string): Tab;
  renameTab(id: ID, name: string): void;
  setTabLocation(id: ID, location: string): void;
  setTabSettings(id: ID, settings: BoardSettings): void;
  setTabStarred(id: ID, starred: boolean): void;
  setTabDoc(id: ID, doc: unknown): void;
  deleteTab(id: ID): void;
  setActiveTab(id: ID | null): void;
  setBoardView(view: BoardView): void;

  upsertTask(t: Partial<Task> & { id: ID; homeTabId: ID; text: string }): Task;
  setTaskMeta(id: ID, meta: Partial<Pick<Task, 'date' | 'priority' | 'owner' | 'done' | 'status' | 'assigneeId' | 'reviewerId' | 'position' | 'rank'>>): void;
  setTaskText(id: ID, text: string): void;
  /** Re-parent a task. Always assigns a rank in the new sibling group (append unless given). */
  setTaskParent(id: ID, parentTaskId: ID | undefined, rank?: string): void;
  /** Reorder and/or re-parent by dropping between two known neighbours. One row changes. */
  moveTask(id: ID, to: { parentTaskId?: ID | undefined; before?: ID; after?: ID }): void;
  setTaskStatus(id: ID, status: TaskStatus): void;
  setTaskAssignee(id: ID, assigneeId: ID | undefined): void;
  toggleTaskDone(id: ID): void;
  deleteTask(id: ID): void;
  deleteOrphanTasks(homeTabId: ID, keepIds: Set<ID>): void;

  // Calendar UI state (day/week cursor + open flag; the planner* names are retained).
  setPlannerOpen(open: boolean): void;
  setPlannerDate(date: string): void;
  setPlannerMode(mode: PlannerMode): void;

  // Calendar — events for the current window (own board-less + member boards). Reads via
  // setEvents; writes are optimistic + durable-outbox. See src/components/calendar.
  setEvents(events: CalendarEvent[]): void;
  createEvent(input: { tabId?: ID | null; title?: string | null; start: string | null; end: string | null; allDay?: boolean; filter?: BlockFilter | null; createdBy?: ID | null }): CalendarEvent;
  updateEvent(id: ID, patch: Partial<Omit<CalendarEvent, 'id' | 'createdBy' | 'occurrences'>>): void;
  deleteEvent(id: ID): void;
  rsvpEvent(id: ID, occurrenceDate: string, userId: ID, status: RsvpStatus): void;

  setFilter(patch: Partial<Filter>): void;
  resetFilter(): void;

  cleanupEmptyTasks(): number;

  // `keepTaskIds` = tasks with an un-acked local write; their local value is preserved so a
  // resync/repull can't revert an optimistic edit the server hasn't seen yet.
  hydrate(state: RootState, keepTaskIds?: Set<ID>): void;

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
    events: {},
    membersByBoard: {},
    projectOrder: [defaultProjectId, personalProjectId],
    tabOrder: [sampleTabId, personalTabId],
    starredRowOrder: [sampleTabId],
    activeTabId: null,
    boardView: 'doc',
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

  // On a board with requireReview set, `done` is reachable only via the in_review → done approval —
  // the server rejects a direct jump (auth/boards.ts). Mirror that here so "mark done" instead
  // submits the task for review (→ in_review), avoiding an optimistic done that the server bounces.
  // Approving an already-in_review task (the reviewer's done) passes through unchanged.
  const reviewGate = (id: ID, target: TaskStatus): TaskStatus => {
    if (target !== 'done') return target;
    const t = get().tasks[id];
    if (!t || (t.status ?? 'todo') === 'in_review') return target;
    return get().tabs[t.homeTabId]?.settings?.requireReview ? 'in_review' : target;
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
        dlog('store', `createTab board=${sid(id)} "${name}" → optimistic + enqueue POST /api/tabs (async outbox)`);
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
      setTabSettings(id, settings) {
        set((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], settings } } }));
        // Send explicit values so the server replaces (a null clears restrictDelete) rather
        // than partial-merging, keeping the persisted bag exactly what the UI shows.
        enqueue(() =>
          api.tabs.update(id, {
            settings: { requireReview: settings.requireReview ?? false, restrictDelete: settings.restrictDelete ?? null },
          }),
        );
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
        // Opening a board lands on the doc view; leaving resets too (harmless). Any board /
        // space / home selection also leaves the calendar (they share the main content area).
        set({ activeTabId: id, boardView: 'doc', plannerOpen: false });
      },
      setBoardView(view) {
        set({ boardView: view });
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
          parentTaskId: meta.parentTaskId ?? existing?.parentTaskId,
          owner: meta.owner ?? existing?.owner,
          position: meta.position ?? existing?.position ?? 0,
          done: status === 'done',
          // Every task gets a sibling rank at birth, so nothing ever renders in an undefined
          // order. An explicit rank wins; an existing one is preserved; otherwise append.
          rank:
            meta.rank ??
            existing?.rank ??
            nextRank(get().tasks, homeTabId, meta.parentTaskId ?? existing?.parentTaskId),
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
      setTaskParent(id, parentTaskId, rank) {
        // Both fields move together: a rank is only meaningful against ONE set of siblings, so
        // carrying the old key across a re-parent would place the task arbitrarily under its new
        // parent. Caller may pass an explicit rank (a drop between two known neighbours); with none
        // we append. persist.ts diffs both and emits a single PATCH.
        const t = get().tasks[id];
        if (!t) return;
        patchTask(id, { parentTaskId, rank: rank ?? nextRank(get().tasks, t.homeTabId, parentTaskId) });
      },
      moveTask(id, { parentTaskId, before, after }) {
        // Reorder / re-parent in one write. `before`/`after` are the ids this task is being dropped
        // between; the new key is computed strictly between their ranks, so ONE row changes no
        // matter how long the list is — that is the whole point of fractional keys (D4).
        const tasks = get().tasks;
        const t = tasks[id];
        if (!t) return;
        const parent = parentTaskId === undefined ? t.parentTaskId : parentTaskId;
        const lo = before ? tasks[before]?.rank ?? null : null;
        const hi = after ? tasks[after]?.rank ?? null : null;
        let rank: string;
        try {
          rank = rankBetween(lo, hi);
        } catch {
          // Neighbours out of order or unranked (a pre-backfill row) — fall back to appending
          // rather than writing a key that would sort somewhere unpredictable.
          rank = nextRank(tasks, t.homeTabId, parent);
        }
        patchTask(id, { parentTaskId: parent, rank });
      },
      setTaskStatus(id, status) {
        const next = reviewGate(id, status);
        patchTask(id, { status: next, done: next === 'done' });
      },
      setTaskAssignee(id, assigneeId) {
        patchTask(id, { assigneeId });
      },
      toggleTaskDone(id) {
        const t = get().tasks[id];
        if (!t) return;
        const target: TaskStatus = (t.status ?? 'todo') === 'done' ? 'todo' : 'done';
        const next = reviewGate(id, target);
        patchTask(id, { status: next, done: next === 'done' });
      },
      deleteTask(id) {
        // The SUBTREE goes with it (SUBTASKS_PLAN D7) — a parent is a commitment and its sub-tasks
        // are the work under it. The server cascades the same way, so dropping only this row here
        // would leave the children rendering locally until the next full state pull.
        set((s) => {
          const doomed = new Set<ID>([id, ...descendantsOf(s.tasks, id).map((t) => t.id)]);
          const tasks: Record<ID, Task> = {};
          for (const t of Object.values(s.tasks)) if (!doomed.has(t.id)) tasks[t.id] = t;
          return { tasks };
        });
        // persist.ts sends ONE delete for the topmost removed task; the server walks the subtree.
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

      setPlannerOpen(open) {
        set(open ? { plannerOpen: true, activeTabId: null } : { plannerOpen: false });
      },
      setPlannerDate(date) {
        set({ plannerDate: date });
      },
      setPlannerMode(mode) {
        set({ plannerMode: mode });
      },
      setEvents(events) {
        const map: Record<ID, CalendarEvent> = {};
        for (const e of events) map[e.id] = e;
        set({ events: map });
      },
      createEvent(input) {
        const id = nanoid();
        const start = input.start;
        const event: CalendarEvent = {
          id,
          tabId: input.tabId ?? null,
          title: input.title ?? null,
          start,
          end: input.end,
          allDay: input.allDay ?? false,
          filter: input.filter ?? null,
          createdBy: input.createdBy ?? null,
          occurrences: start ? [{ date: start.slice(0, 10), attendance: [] }] : [],
        };
        set((s) => ({ events: { ...s.events, [id]: event } }));
        enqueue(() =>
          api.calendar.create({ id, tabId: event.tabId, title: event.title, start: event.start, end: event.end, allDay: event.allDay, filter: event.filter }),
        );
        return event;
      },
      updateEvent(id, patch) {
        set((s) => (s.events[id] ? { events: { ...s.events, [id]: { ...s.events[id], ...patch } } } : s));
        enqueue(() => api.calendar.update(id, patch));
      },
      deleteEvent(id) {
        set((s) => {
          const events = { ...s.events };
          delete events[id];
          return { events };
        });
        enqueue(() => api.calendar.remove(id));
      },
      rsvpEvent(id, occurrenceDate, userId, status) {
        set((s) => {
          const ev = s.events[id];
          if (!ev) return s;
          const occ = ev.occurrences ?? [];
          const found = occ.some((o) => o.date === occurrenceDate);
          const occurrences = found
            ? occ.map((o) =>
                o.date === occurrenceDate
                  ? { ...o, attendance: [...o.attendance.filter((a) => a.userId !== userId), { userId, status }] }
                  : o,
              )
            : [...occ, { date: occurrenceDate, attendance: [{ userId, status }] }];
          return { events: { ...s.events, [id]: { ...ev, occurrences } } };
        });
        enqueue(() => api.calendar.rsvp(id, occurrenceDate, status));
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

      hydrate(state, keepTaskIds) {
        // The server's /api/state doesn't own local UI/navigation — it returns defaults for
        // these. Preserve the current values so a reconnect/repull (which re-hydrates) doesn't
        // close the open board, drop the active filter, or reset the Planner. The open board
        // lives in the URL (src/App.tsx), so on a fresh load `activeTabId` starts null here and
        // is restored from the path right after.
        const cur = get();
        // Same "preserve local truth" contract for task entities that still have an un-acked
        // write in flight: keep the local row (or keep it deleted, for a pending delete) so the
        // rehydrate never clobbers an optimistic edit the server hasn't caught up to yet.
        let tasks = state.tasks;
        if (keepTaskIds && keepTaskIds.size) {
          tasks = { ...state.tasks };
          for (const id of keepTaskIds) {
            const local = cur.tasks[id];
            if (local) tasks[id] = local;
            else delete tasks[id];
          }
        }
        set({
          ...state,
          tasks,
          events: state.events ?? {},
          plannerOpen: false,
          plannerDate: state.plannerDate ?? todayISO(),
          plannerMode: state.plannerMode ?? 'day',
          activeTabId: cur.activeTabId,
          boardView: cur.boardView,
          filter: cur.filter,
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
  // Select the stable tasks map, then derive — returning a fresh filtered array straight
  // from the selector makes useSyncExternalStore see a new snapshot every render (infinite
  // update loop).
  const tasks = useStore((s) => s.tasks);
  return useMemo(() => Object.values(tasks).filter((t) => t.homeTabId === tabId), [tasks, tabId]);
}

/**
 * A board's tasks in outline order (SUBTASKS_PLAN D4), plus the id→index map a filtered view sorts
 * its own subset by. Any view that shows a slice of a board — a Kanban column, a status section, a
 * filtered agenda — should read `order` rather than inventing an ordering of its own.
 */
export function useBoardOutline(tabId: ID): { list: Task[]; order: Map<ID, number> } {
  const tasks = useStore((s) => s.tasks);
  return useMemo(() => outlineOrder(tasks, tabId), [tasks, tabId]);
}

export function getTask(id: ID): Task | undefined {
  return useStore.getState().tasks[id];
}
