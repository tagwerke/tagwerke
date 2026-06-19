// Reassembles the client RootState shape from normalized rows for one user.
// Mirrors src/types.ts. `filter` and `activeTabId` are client-side concerns and
// are returned as defaults; `todayTabId` is derived (the tab with type='today').
//
// v2: access derives from board_members, not from a user_id column. A tab is visible
// because the user has a membership row; that same row supplies the per-user view
// state (category/order/starred). The OUTPUT shape is unchanged — `tab.projectId` is
// the member's category, `tab.order`/`starred` come from the membership — so the
// client is untouched by the ownership pivot.

import { asc, eq, inArray } from 'drizzle-orm';
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
  // The user's boards (via membership) joined to shared tab content. The membership
  // row carries this user's personal view state for each board.
  const membershipRows = await db
    .select({
      id: schema.tabs.id,
      name: schema.tabs.name,
      type: schema.tabs.type,
      docJSON: schema.tabs.docJSON,
      dateKey: schema.tabs.dateKey,
      location: schema.tabs.location,
      categoryId: schema.boardMembers.categoryId,
      position: schema.boardMembers.position,
      starred: schema.boardMembers.starred,
      starredPosition: schema.boardMembers.starredPosition,
    })
    .from(schema.boardMembers)
    .innerJoin(schema.tabs, eq(schema.boardMembers.tabId, schema.tabs.id))
    .where(eq(schema.boardMembers.userId, userId))
    .orderBy(asc(schema.boardMembers.position));

  const tabIds = membershipRows.map((t) => t.id);

  const [projectRows, taskRows, snapshotRows, blockRows, blockTaskRows] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.userId, userId)).orderBy(asc(schema.projects.position)),
    // Tasks of any board the user can see (not tasks.userId).
    tabIds.length
      ? db.select().from(schema.tasks).where(inArray(schema.tasks.homeTabId, tabIds))
      : Promise.resolve([] as (typeof schema.tasks.$inferSelect)[]),
    db.select().from(schema.snapshots).where(eq(schema.snapshots.userId, userId)),
    // TODAY blocks remain personal (owned by the user's today tab).
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
  for (const t of membershipRows) {
    const isToday = t.type === 'today';
    if (isToday) todayTabId = t.id;
    tabs[t.id] = {
      id: t.id,
      projectId: t.categoryId, // member's personal category
      name: t.name,
      order: t.position,
      starred: t.starred,
      type: t.type,
      docJSON: t.docJSON ?? undefined,
      ...(t.location != null ? { location: t.location } : {}),
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
