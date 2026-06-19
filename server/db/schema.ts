// Drizzle schema for do-app. Normalized, multi-user; every child row carries
// user_id for single-column isolation. Client-generated string ids are text PKs
// (ids vary in format: nanoid(8), `t_${nanoid(8)}`, `t_${random}`), so no length
// or format constraints. `order` is a SQL reserved word -> column is `position`.

import {
  pgTable,
  text,
  integer,
  smallint,
  boolean,
  jsonb,
  bigint,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Brute-force protection: failed login counter + temporary lock.
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  // Platform role. 'admin' may mint signup invites and access the admin dashboard.
  // The extra admin auth layer (Tailscale-style) is infra, not modeled here.
  role: text('role').notNull().default('member'),
});

// Signup invites. A code may allow multiple uses and/or expire. Later this can
// carry team_id/role to become a team invite.
export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  note: text('note'),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [index('projects_user_idx').on(t.userId)],
);

export const tabs = pgTable(
  'tabs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // v2: position/starred/starredPosition/projectId are per-USER view state and are
    // being relocated to board_members. Kept here through the additive migration; the
    // read/write paths move to board_members (Phase 3), then these are dropped (Phase 6).
    position: integer('position').notNull(),
    starred: boolean('starred').notNull().default(false),
    starredPosition: integer('starred_position'),
    // 'normal' | 'today'
    type: text('type').notNull().default('normal'),
    dateKey: text('date_key'),
    docJSON: jsonb('doc_json'),
    // v2 board facets / attribution.
    location: text('location'),
    createdBy: text('created_by'), // attribution; access derives from board_members
  },
  (t) => [index('tabs_user_idx').on(t.userId), index('tabs_project_idx').on(t.projectId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    homeTabId: text('home_tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    date: text('date'),
    priority: smallint('priority'),
    // v2: owner becomes a real user id (the [Name] token → a board member), not free text.
    owner: text('owner'),
    done: boolean('done').notNull().default(false),
    createdBy: text('created_by'), // attribution; access derives from the home tab's board
  },
  (t) => [index('tasks_user_idx').on(t.userId), index('tasks_home_tab_idx').on(t.homeTabId)],
);

// v2 collaboration: a board's access list AND each member's personal view of it.
// PK (tab_id, user_id). A "private" board is just a board with one admin member.
// role: 'viewer' | 'editor' | 'admin'. category_id is the member's personal filing
// (-> projects.id, now used as personal categories). starred/position are per-member.
export const boardMembers = pgTable(
  'board_members',
  {
    tabId: text('tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'),
    categoryId: text('category_id'), // -> projects.id (personal category); nullable
    position: integer('position').notNull().default(0),
    starred: boolean('starred').notNull().default(false),
    starredPosition: integer('starred_position'),
  },
  (t) => [
    primaryKey({ columns: [t.tabId, t.userId] }),
    index('board_members_user_idx').on(t.userId),
  ],
);

// v2 calendar facet. Recurrence stored as an iCal RRULE (RFC 5545); occurrences are
// expanded on read (no row-per-occurrence). uid = portable iCal identity. external_*
// / sync_token are inert hooks for future Google Calendar / iCal sync.
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    tabId: text('tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    start: text('start'), // ISO datetime
    end: text('end'),
    rrule: text('rrule'),
    uid: text('uid'),
    externalEventId: text('external_event_id'),
    externalCalId: text('external_cal_id'),
    syncToken: text('sync_token'),
  },
  (t) => [index('events_tab_idx').on(t.tabId)],
);

// v2 attendance roster, members-only. (event_id, occurrence_date, user_id) maps to
// iCal ATTENDEE + RECURRENCE-ID + PARTSTAT. status:
// 'accepted' | 'declined' | 'tentative' | 'needs-action' (= going / not / maybe / no-reply).
export const eventAttendance = pgTable(
  'event_attendance',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    occurrenceDate: text('occurrence_date').notNull(), // 'YYYY-MM-DD' of the instance
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('needs-action'),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.occurrenceDate, t.userId] })],
);

export const todayBlocks = pgTable(
  'today_blocks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The TODAY tab that owns this block.
    tabId: text('tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    // The block's source/home tab (= TodayBlock.tabId in the client model).
    homeTabId: text('home_tab_id'),
    start: text('start'),
    end: text('end'),
    label: text('label'),
    position: integer('position').notNull(),
  },
  (t) => [index('today_blocks_user_idx').on(t.userId), index('today_blocks_tab_idx').on(t.tabId)],
);

export const todayBlockTasks = pgTable(
  'today_block_tasks',
  {
    blockId: text('block_id')
      .notNull()
      .references(() => todayBlocks.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.taskId] })],
);

export const snapshots = pgTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dateKey: text('date_key').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    text: text('text').notNull(),
  },
  (t) => [index('snapshots_user_idx').on(t.userId)],
);
