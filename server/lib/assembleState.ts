// Reassembles the client RootState shape from normalized rows for one user.
// Mirrors src/types.ts. `filter` and `activeTabId` are client-side concerns and are
// returned as defaults. Calendar events are NOT here — they're windowed + span boards, so
// the client lazy-fetches them via GET /api/calendar/events.
//
// v2: access derives from board_members, not from a user_id column. A tab is visible
// because the user has a membership row; that same row supplies the per-user view
// state (category/order/starred). The OUTPUT shape is unchanged — `tab.projectId` is
// the member's category, `tab.order`/`starred` come from the membership — so the
// client is untouched by the ownership pivot.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

export async function assembleState(userId: string) {
  // The user's boards (via membership) joined to shared tab content. The membership
  // row carries this user's personal view state for each board.
  const membershipRows = await db
    .select({
      id: schema.tabs.id,
      name: schema.tabs.name,
      type: schema.tabs.type,
      docJSON: schema.tabs.docJSON,
      docVersion: schema.tabs.docVersion,
      location: schema.tabs.location,
      settings: schema.tabs.settings,
      role: schema.boardMembers.role, // the caller's own role → drives read-only vs editable UI
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

  const [projectRows, taskRows] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.userId, userId)).orderBy(asc(schema.projects.position)),
    // Tasks of any board the user can see (not tasks.userId). Trashed tasks are excluded.
    tabIds.length
      ? db.select().from(schema.tasks).where(and(inArray(schema.tasks.homeTabId, tabIds), isNull(schema.tasks.deletedAt)))
      : Promise.resolve([] as (typeof schema.tasks.$inferSelect)[]),
  ]);

  const projects: Record<string, unknown> = {};
  const projectOrder: string[] = [];
  for (const p of projectRows) {
    projects[p.id] = { id: p.id, name: p.name, color: p.color, order: p.position };
    projectOrder.push(p.id);
  }

  const tabs: Record<string, unknown> = {};
  const tabOrder: string[] = [];
  const starred: { id: string; pos: number }[] = [];
  for (const t of membershipRows) {
    tabs[t.id] = {
      id: t.id,
      projectId: t.categoryId, // member's personal category
      name: t.name,
      order: t.position,
      starred: t.starred,
      type: t.type,
      role: t.role, // caller's own board role
      docJSON: t.docJSON ?? undefined,
      docVersion: t.docVersion,
      settings: t.settings ?? {},
      ...(t.location != null ? { location: t.location } : {}),
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
      status: t.status,
      done: t.done, // back-compat mirror during the transition
      position: t.position,
      createdAt: t.createdAt instanceof Date ? t.createdAt.getTime() : undefined,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.getTime() : undefined,
      ...(t.assigneeId != null ? { assigneeId: t.assigneeId } : {}),
      ...(t.reviewerId != null ? { reviewerId: t.reviewerId } : {}),
      ...(t.approvedBy != null ? { approvedBy: t.approvedBy } : {}),
      ...(t.approvedAt instanceof Date ? { approvedAt: t.approvedAt.getTime() } : {}),
      ...(t.date != null ? { date: t.date } : {}),
      ...(t.priority != null ? { priority: t.priority } : {}),
      ...(t.parentTaskId != null ? { parentTaskId: t.parentTaskId } : {}),
      ...(t.owner != null ? { owner: t.owner } : {}),
    };
  }

  // Per-board member rosters — the source the `@` assignee picker reads (SPEC §5).
  // Keyed by board id; only boards the user can see. No display name in the DB yet,
  // so `name` is the email local-part.
  const membersByBoard: Record<string, { id: string; email: string; name: string }[]> = {};
  if (tabIds.length) {
    const memberRows = await db
      .select({
        tabId: schema.boardMembers.tabId,
        userId: schema.boardMembers.userId,
        email: schema.users.email,
      })
      .from(schema.boardMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.boardMembers.userId))
      .where(inArray(schema.boardMembers.tabId, tabIds));
    for (const m of memberRows) {
      const list = membersByBoard[m.tabId] ?? (membersByBoard[m.tabId] = []);
      list.push({ id: m.userId, email: m.email, name: m.email.split('@')[0] });
    }
  }

  return {
    projects,
    tabs,
    tasks,
    membersByBoard,
    projectOrder,
    tabOrder,
    starredRowOrder,
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
