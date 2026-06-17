// Reassembles the client RootState shape from normalized rows for one user.
// Mirrors src/types.ts. `filter` and `activeTabId` are client-side concerns and
// are returned as defaults; `todayTabId` is derived (the tab with type='today').

import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

interface TodayBlockOut {
  id: string;
  tabId: string;
  start?: string;
  end?: string;
  taskIds: string[];
  label?: string;
}

export async function assembleState(userId: string) {
  const [projectRows, tabRows, taskRows, snapshotRows, blockRows, blockTaskRows] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.userId, userId)).orderBy(asc(schema.projects.position)),
    db.select().from(schema.tabs).where(eq(schema.tabs.userId, userId)).orderBy(asc(schema.tabs.position)),
    db.select().from(schema.tasks).where(eq(schema.tasks.userId, userId)),
    db.select().from(schema.snapshots).where(eq(schema.snapshots.userId, userId)),
    db.select().from(schema.todayBlocks).where(eq(schema.todayBlocks.userId, userId)).orderBy(asc(schema.todayBlocks.position)),
    db.select().from(schema.todayBlockTasks),
  ]);

  // taskIds per block, ordered by position. Filter to this user's blocks.
  const blockIds = new Set(blockRows.map((b) => b.id));
  const tasksByBlock = new Map<string, { taskId: string; position: number }[]>();
  for (const bt of blockTaskRows) {
    if (!blockIds.has(bt.blockId)) continue;
    const list = tasksByBlock.get(bt.blockId) ?? [];
    list.push({ taskId: bt.taskId, position: bt.position });
    tasksByBlock.set(bt.blockId, list);
  }

  const blocksByTab = new Map<string, TodayBlockOut[]>();
  for (const b of blockRows) {
    const taskIds = (tasksByBlock.get(b.id) ?? [])
      .sort((a, c) => a.position - c.position)
      .map((x) => x.taskId);
    const block: TodayBlockOut = {
      id: b.id,
      tabId: b.homeTabId ?? '',
      taskIds,
      ...(b.start != null ? { start: b.start } : {}),
      ...(b.end != null ? { end: b.end } : {}),
      ...(b.label != null ? { label: b.label } : {}),
    };
    const list = blocksByTab.get(b.tabId) ?? [];
    list.push(block);
    blocksByTab.set(b.tabId, list);
  }

  const projects: Record<string, unknown> = {};
  const projectOrder: string[] = [];
  for (const p of projectRows) {
    projects[p.id] = { id: p.id, name: p.name, color: p.color, order: p.position };
    projectOrder.push(p.id);
  }

  const tabs: Record<string, unknown> = {};
  const tabOrder: string[] = [];
  const starred: { id: string; pos: number }[] = [];
  let todayTabId = '';
  for (const t of tabRows) {
    const isToday = t.type === 'today';
    if (isToday) todayTabId = t.id;
    tabs[t.id] = {
      id: t.id,
      projectId: t.projectId,
      name: t.name,
      order: t.position,
      starred: t.starred,
      type: t.type,
      docJSON: t.docJSON ?? undefined,
      ...(isToday ? { blocks: blocksByTab.get(t.id) ?? [] } : {}),
      ...(t.dateKey != null ? { dateKey: t.dateKey } : {}),
    };
    tabOrder.push(t.id);
    if (t.starred) starred.push({ id: t.id, pos: t.starredPosition ?? Number.MAX_SAFE_INTEGER });
  }
  const starredRowOrder = starred.sort((a, b) => a.pos - b.pos).map((s) => s.id);

  const tasks: Record<string, unknown> = {};
  for (const t of taskRows) {
    tasks[t.id] = {
      id: t.id,
      homeTabId: t.homeTabId,
      text: t.text,
      done: t.done,
      ...(t.date != null ? { date: t.date } : {}),
      ...(t.priority != null ? { priority: t.priority } : {}),
      ...(t.owner != null ? { owner: t.owner } : {}),
    };
  }

  const snapshots: Record<string, unknown> = {};
  for (const s of snapshotRows) {
    snapshots[s.id] = { id: s.id, dateKey: s.dateKey, createdAt: s.createdAt, text: s.text };
  }

  return {
    projects,
    tabs,
    tasks,
    snapshots,
    projectOrder,
    tabOrder,
    starredRowOrder,
    todayTabId,
    activeTabId: null,
    filter: {
      projectIds: [],
      owners: [],
      priorities: [],
      hasDate: false,
      dueSoon: false,
      query: '',
    },
  };
}
