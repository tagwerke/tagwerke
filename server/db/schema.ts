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
    position: integer('position').notNull(),
    starred: boolean('starred').notNull().default(false),
    starredPosition: integer('starred_position'),
    // 'normal' | 'today'
    type: text('type').notNull().default('normal'),
    dateKey: text('date_key'),
    docJSON: jsonb('doc_json'),
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
    owner: text('owner'),
    done: boolean('done').notNull().default(false),
  },
  (t) => [index('tasks_user_idx').on(t.userId), index('tasks_home_tab_idx').on(t.homeTabId)],
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
