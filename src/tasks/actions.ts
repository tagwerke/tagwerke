// Everything that can be done to a task, defined once (NOTES_SPLIT_PLAN §N3).
//
// The point of this file is that adding a task action later means touching THIS file and nothing
// else. It is reached three ways — the task page as a form, `TaskActionMenu` as a menu or a
// field-scoped cell popover, and the `/` `@` parser in quick-add — and all three read the same
// list, so they cannot drift apart the way four row components did.
//
// Every action takes an ARRAY of ids, so bulk is not a second code path. That is also why the two
// bulk hazards live here rather than at each call site (§N3.1):
//
//   THE CASCADE PROMPT is raised once for the whole selection. `store.offerCascade` writes a single
//   `pendingCascade` slot, so calling it per id over twelve tasks would overwrite the offer eleven
//   times and silently lose it. `offerCascadeFor` exists for exactly this.
//
//   INVALID IDS ARE DROPPED BEFORE THE WRITE, not left for the server to reject. The outbox treats
//   a generic 4xx as poison: it drops the op and fires a blunt state repull that clobbers whatever
//   else was in flight. So anything the server would refuse — a `done` on a review-required board,
//   an assignee who is not a member, a sprint from another board — is filtered here and reported.

import { childrenOf, descendantsOf, siblingsOf, useStore } from '../store';
import { stateOf, stateStyle, visibleStatesOf } from './states';
import { showToast } from '../toast/useToast';
import { formatDateChip, todayISO } from '../util/dates';
import { rankBetween } from '../../shared/rank';
import { MAX_TASK_DEPTH } from '../../shared/tree';
import { navigate, boardTaskPath } from '../util/router';
import { describeMove, moveTargets, moveTaskToBoard } from './moveToBoard';
import { newestFirst } from '../util/sprints';
import type { CSSProperties } from 'react';
import type { BoardSettingsSection, ID, Member, Task } from '../types';

/** Which field a cell click scopes the menu to. Matches the table's column keys. */
export type FocusField = 'status' | 'assignee' | 'due' | 'priority' | 'sprint';

export interface ActionContext {
  ids: ID[];
  tabId: ID;
}

export interface ChoiceOption {
  key: string;
  label: string;
  /** Rendered dim after the label — a date's weekday, a member's email. */
  hint?: string;
  /** Paints the choice's status swatch, when it has one. */
  swatchStyle?: CSSProperties;
  selected?: boolean;
  run(): void;
}

export interface TaskAction {
  id: string;
  label: string;
  /** Single-key shortcut on a focused row (§I.2). */
  key?: string;
  /** Set when this action is a field, so a cell click can open straight into it. */
  field?: FocusField;
  danger?: boolean;
  enabled(ctx: ActionContext): boolean;
  /** A field action lists choices; a command action omits this and runs directly. */
  options?(ctx: ActionContext): ChoiceOption[];
  run?(ctx: ActionContext): void;
}

// ── Shared helpers ────────────────────────────────────────────────────────────────────────────

function tasksOf(ids: ID[]): Task[] {
  const all = useStore.getState().tasks;
  return ids.map((id) => all[id]).filter((t): t is Task => !!t);
}

function canEdit(tabId: ID): boolean {
  const role = useStore.getState().tabs[tabId]?.role;
  return role === 'editor' || role === 'admin';
}

function membersOf(tabId: ID): Member[] {
  return useStore.getState().membersByBoard[tabId] ?? [];
}

/**
 * The last choice in a field's list: a way into the board's settings, where that list is kept —
 * "Edit states…" under the states, "Invite someone…" under the people. Not a value, so it is never
 * `selected`; choosing it opens settings instead of writing to the tasks.
 */
function settingsChoice(tabId: ID, section: BoardSettingsSection, label: string): ChoiceOption {
  return { key: `settings:${section}`, label, run: () => useStore.getState().openBoardSettings(tabId, section) };
}

function isAdmin(tabId: ID): boolean {
  return useStore.getState().tabs[tabId]?.role === 'admin';
}

/** "3 tasks" / the single task's title — for a toast that has to name what it acted on. */
function subject(ids: ID[]): string {
  if (ids.length !== 1) return `${ids.length} tasks`;
  const t = useStore.getState().tasks[ids[0]];
  return t?.text?.trim() ? `“${t.text.trim()}”` : 'the task';
}

// ── Status ────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply a status across a selection, then raise ONE cascade offer.
 *
 * `setTaskStatus` already runs the board's review gate per task (a `done` on a review-required
 * board becomes `in_review`), which is what keeps this off the outbox's poison path — the write
 * that goes out is one the server accepts. What it also does per task is `offerCascade`, so this
 * deliberately does not use it for the sweep: it sets the field directly and asks once at the end.
 */
function applyStatus(tabId: ID, ids: ID[], status: string): void {
  const store = useStore.getState();
  for (const id of ids) store.setTaskStatus(id, status);
  if (stateOf(tabId, status).category === 'done') store.offerCascadeFor(ids);
}

const statusAction: TaskAction = {
  id: 'status',
  label: 'Status',
  key: 's',
  field: 'status',
  enabled: (ctx) => canEdit(ctx.tabId),
  options: (ctx) => {
    const current = new Set(tasksOf(ctx.ids).map((t) => t.status));
    return [
      ...visibleStatesOf(ctx.tabId).map((s) => ({
        key: s.key,
        label: s.label,
        swatchStyle: stateStyle(s),
        selected: current.size === 1 && current.has(s.key),
        run: () => applyStatus(ctx.tabId, ctx.ids, s.key),
      })),
      settingsChoice(ctx.tabId, 'states', isAdmin(ctx.tabId) ? 'Edit states…' : 'What these states mean…'),
    ];
  },
};

// ── Assignee ──────────────────────────────────────────────────────────────────────────────────

function peopleOptions(ctx: ActionContext): ChoiceOption[] {
  const members = membersOf(ctx.tabId);
  const current = new Set(tasksOf(ctx.ids).map((t) => t.assigneeId ?? null));
  const set = (memberId: ID | undefined) => () => {
    const store = useStore.getState();
    for (const id of ctx.ids) store.setTaskAssignee(id, memberId);
  };
  return [
    { key: 'none', label: 'Nobody', selected: current.size === 1 && current.has(null), run: set(undefined) },
    ...members.map((m) => ({
      key: m.id,
      label: m.name,
      hint: m.email,
      selected: current.size === 1 && current.has(m.id),
      run: set(m.id),
    })),
    settingsChoice(ctx.tabId, 'people', isAdmin(ctx.tabId) ? 'Invite someone…' : 'See who’s on this board…'),
  ];
}

const assigneeAction: TaskAction = {
  id: 'assignee',
  label: 'Assignee',
  key: 'a',
  field: 'assignee',
  // The server constrains assignee to a member of the home board, so a board with no roster
  // loaded yet offers nothing rather than a list that would be rejected.
  enabled: (ctx) => canEdit(ctx.tabId) && membersOf(ctx.tabId).length > 0,
  options: (ctx) => peopleOptions(ctx),
};

// ── Due date ──────────────────────────────────────────────────────────────────────────────────

/** `days` from today as an ISO date. Local-time arithmetic, matching util/dates. */
function offsetISO(days: number): string {
  const d = new Date(`${todayISO()}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dueAction: TaskAction = {
  id: 'due',
  label: 'Due date',
  key: 'd',
  field: 'due',
  enabled: (ctx) => canEdit(ctx.tabId),
  options: (ctx) => {
    const set = (date: string | undefined) => () => {
      const store = useStore.getState();
      for (const id of ctx.ids) store.setTaskMeta(id, { date });
    };
    const daysToMonday = ((8 - new Date(`${todayISO()}T00:00:00`).getDay()) % 7) || 7;
    return [
      { key: 'today', label: 'Today', hint: formatDateChip(offsetISO(0)), run: set(offsetISO(0)) },
      { key: 'tomorrow', label: 'Tomorrow', hint: formatDateChip(offsetISO(1)), run: set(offsetISO(1)) },
      { key: 'week', label: 'Next week', hint: formatDateChip(offsetISO(daysToMonday)), run: set(offsetISO(daysToMonday)) },
      { key: 'none', label: 'No date', run: set(undefined) },
    ];
  },
};

// ── Priority ──────────────────────────────────────────────────────────────────────────────────

const priorityAction: TaskAction = {
  id: 'priority',
  label: 'Priority',
  key: 'p',
  field: 'priority',
  enabled: (ctx) => canEdit(ctx.tabId),
  options: (ctx) => {
    const current = new Set(tasksOf(ctx.ids).map((t) => t.priority ?? null));
    const set = (priority: 1 | 2 | 3 | undefined) => () => {
      const store = useStore.getState();
      for (const id of ctx.ids) store.setTaskMeta(id, { priority });
    };
    return [
      ...([3, 2, 1] as const).map((p) => ({
        key: `p${p}`,
        label: '!'.repeat(p),
        hint: p === 3 ? 'highest' : p === 1 ? 'lowest' : undefined,
        selected: current.size === 1 && current.has(p),
        run: set(p),
      })),
      { key: 'none', label: 'None', selected: current.size === 1 && current.has(null), run: set(undefined) },
    ];
  },
};

// ── Sprint ────────────────────────────────────────────────────────────────────────────────────

const sprintAction: TaskAction = {
  id: 'sprint',
  label: 'Sprint',
  key: 'r',
  field: 'sprint',
  enabled: (ctx) => canEdit(ctx.tabId) && (useStore.getState().sprintsByBoard[ctx.tabId] ?? []).length > 0,
  options: (ctx) => {
    // Same-board only: the server rejects a sprint from elsewhere, and a rejected write poisons
    // the outbox. Reading them from this board's list is what makes that unreachable.
    const sprints = useStore.getState().sprintsByBoard[ctx.tabId] ?? [];
    const current = new Set(tasksOf(ctx.ids).map((t) => t.sprintId ?? null));
    const set = (sprintId: ID | undefined) => () => {
      const store = useStore.getState();
      for (const id of ctx.ids) store.setTaskMeta(id, { sprintId });
    };
    // Backlog, then newest first — the order every other sprint list on the board uses.
    return [
      { key: 'none', label: 'Backlog', selected: current.size === 1 && current.has(null), run: set(undefined) },
      ...newestFirst(sprints).map((s) => ({
        key: s.id,
        label: s.label,
        hint: s.isCurrent ? 'current' : undefined,
        selected: current.size === 1 && current.has(s.id),
        run: set(s.id),
      })),
      settingsChoice(ctx.tabId, 'sprints', 'Manage sprints…'),
    ];
  },
};

// ── Commands ──────────────────────────────────────────────────────────────────────────────────

const nestAction: TaskAction = {
  id: 'nest',
  label: 'Nest under previous',
  key: 'Tab',
  enabled: (ctx) => canEdit(ctx.tabId) && ctx.ids.length === 1,
  run: (ctx) => {
    const store = useStore.getState();
    const t = store.tasks[ctx.ids[0]];
    if (!t) return;
    const sibs = siblingsOf(store.tasks, t.homeTabId, t.parentTaskId);
    const prev = sibs[sibs.findIndex((s) => s.id === t.id) - 1];
    if (!prev) return showToast('Nothing above it to nest under');
    // Depth is enforced server-side too; checking here keeps the write off the poison path.
    const depthOf = (id: ID | undefined, d = 0): number => (id ? depthOf(store.tasks[id]?.parentTaskId, d + 1) : d);
    const height = (id: ID, d = 0): number =>
      Math.max(d, ...childrenOf(store.tasks, id).map((c) => height(c.id, d + 1)));
    if (depthOf(prev.id) + 1 + height(t.id) > MAX_TASK_DEPTH) return showToast('That would nest too deep');
    const kids = childrenOf(store.tasks, prev.id);
    store.setTaskParent(t.id, prev.id, rankBetween(kids[kids.length - 1]?.rank ?? null, null));
  },
};

const unnestAction: TaskAction = {
  id: 'unnest',
  label: 'Move out of parent',
  enabled: (ctx) => canEdit(ctx.tabId) && ctx.ids.length === 1 && !!tasksOf(ctx.ids)[0]?.parentTaskId,
  run: (ctx) => {
    const store = useStore.getState();
    const t = store.tasks[ctx.ids[0]];
    const parent = t?.parentTaskId ? store.tasks[t.parentTaskId] : undefined;
    if (!t || !parent) return;
    // Land directly after the old parent, which is where it visually was. Bounded on BOTH sides:
    // with only the parent as a floor, the new key was the next whole step up — which is often
    // exactly the parent's next sibling's key, so the two tied and the order became arbitrary.
    const aunts = siblingsOf(store.tasks, parent.homeTabId, parent.parentTaskId);
    const next = aunts[aunts.findIndex((s) => s.id === parent.id) + 1];
    store.moveTask(t.id, { parentTaskId: parent.parentTaskId ?? null, before: parent.id, after: next?.id });
  },
};

const moveAction: TaskAction = {
  id: 'move',
  label: 'Move to board',
  key: 'm',
  // One at a time: a move is a per-task round-trip that can clear assignments the destination
  // roster cannot hold, and each one reports what it dropped. Batching them would bury that.
  enabled: (ctx) => canEdit(ctx.tabId) && ctx.ids.length === 1,
  options: (ctx) => {
    const tabs = useStore.getState().tabs;
    return moveTargets(tabs, ctx.tabId).map((t) => ({
      key: t.id,
      label: t.name,
      run: () => {
        void moveTaskToBoard(ctx.ids[0], t.id, t.name)
          .then((result) => { if (result) showToast(describeMove(result, t.name)); })
          .catch(() => showToast('Could not move the task'));
      },
    }));
  },
};

const openAction: TaskAction = {
  id: 'open',
  label: 'Open task',
  key: 'o',
  enabled: (ctx) => ctx.ids.length === 1,
  run: (ctx) => navigate(boardTaskPath(ctx.tabId, ctx.ids[0])),
};

const deleteAction: TaskAction = {
  id: 'delete',
  label: 'Delete',
  key: 'Delete',
  danger: true,
  enabled: (ctx) => canEdit(ctx.tabId),
  run: (ctx) => {
    const store = useStore.getState();
    // Deleting a parent takes its subtree (SUBTASKS_PLAN D7); say so rather than surprising anyone.
    const extra = new Set<ID>();
    for (const id of ctx.ids) for (const d of descendantsOf(store.tasks, id)) if (!ctx.ids.includes(d.id)) extra.add(d.id);
    for (const id of ctx.ids) store.deleteTask(id);
    const sub = extra.size ? ` and ${extra.size} sub-task${extra.size === 1 ? '' : 's'}` : '';
    showToast(`Deleted ${subject(ctx.ids)}${sub} — restore from the board's Trash`);
  },
};

/**
 * The list, in menu order. Fields first (they are what a cell click opens into), then the
 * structural commands, then the two that leave or end a task.
 */
export const TASK_ACTIONS: TaskAction[] = [
  statusAction,
  assigneeAction,
  dueAction,
  priorityAction,
  sprintAction,
  nestAction,
  unnestAction,
  moveAction,
  openAction,
  deleteAction,
];

export function actionsFor(ctx: ActionContext): TaskAction[] {
  return TASK_ACTIONS.filter((a) => a.enabled(ctx));
}

export function actionForField(field: FocusField): TaskAction | undefined {
  return TASK_ACTIONS.find((a) => a.field === field);
}
