// Drizzle schema for do-app. Normalized, multi-user. Access derives from
// `board_members` (a tab/board is shared content; per-user view state + role live on
// the membership row); `tasks` are scoped via their `home_tab_id`. The legacy
// per-row `user_id`/`project_id`/`starred`/`position` columns on `tabs`/`tasks` were
// dropped in migration 0003 — `projects`, `sessions`, `today_blocks`, `snapshots`
// still carry `user_id` as they remain per-user. Client-generated string ids are text
// PKs (ids vary: nanoid(8), `t_${nanoid(8)}`, `t_${random}`), so no length/format
// constraints. `order` is a SQL reserved word -> column is `position`.

import {
  pgTable,
  text,
  integer,
  smallint,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// Singleton workspace/org record — ONE row per self-hosted instance: the org IS the
// deployment (if you have an account, you're in the org). Holds the workspace name and
// a `config` blob that is the future home for SSO/SCIM settings. Seeded on boot with a
// fixed id. See AUTH_IMPLEMENTATION_PLAN.md (Slice 1).
export const org = pgTable('org', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  // Nullable: SSO-provisioned (OIDC) users have no password. Password login is rejected
  // when this is null. See AUTH_IMPLEMENTATION_PLAN.md (Slice 6 / SSO).
  passwordHash: text('password_hash'),
  // OIDC subject (`sub` claim) — the stable identity for a returning SSO user (email can
  // change). Set on first SSO login (JIT or account-link).
  oidcSubject: text('oidc_subject'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Brute-force protection: failed login counter + temporary lock.
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  // Platform role. 'admin' may mint signup invites and access the admin dashboard.
  // The extra admin auth layer (Tailscale-style) is infra, not modeled here.
  role: text('role').notNull().default('member'),
  // MFA (TOTP). `totpSecret` is the base32 shared secret; `totpEnabled` flips on only
  // after the first code is verified; `backupCodes` is a jsonb array of HASHED one-time
  // codes (Argon2). See AUTH_IMPLEMENTATION_PLAN.md (Slice 5).
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  backupCodes: jsonb('backup_codes'),
  // Account deactivation (suspend without deleting). A non-null timestamp blocks login and
  // invalidates sessions. The hook SCIM deprovisioning will set. See AUTH_IMPLEMENTATION_PLAN.md (Slice 7).
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
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
    // Step-up ("sudo") grant: set when an admin re-authenticates; admin actions require it
    // to be recent (short TTL). Per-session. See AUTH_IMPLEMENTATION_PLAN.md (admin page).
    sudoAt: timestamp('sudo_at', { withTimezone: true }),
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

// v2: a tab IS a board. It holds only SHARED content + attribution. Per-user view
// state (category/order/starred) lives on board_members; access derives from there.
export const tabs = pgTable(
  'tabs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // 'normal' | 'today'
    type: text('type').notNull().default('normal'),
    dateKey: text('date_key'),
    docJSON: jsonb('doc_json'),
    // Board facets / attribution.
    location: text('location'),
    createdBy: text('created_by'), // attribution; access derives from board_members
  },
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    homeTabId: text('home_tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    // P0: status is the authoritative state field (todo|in_progress|in_review|done|cancelled).
    // `done` is retained for one release as a derived/back-compat mirror (= status==='done').
    status: text('status').notNull().default('todo'),
    // P0: real user id of the assignee, constrained in app logic to a member of the home board.
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    date: text('date'),
    priority: smallint('priority'),
    // P0: explicit order — doc order ≠ Kanban/My-Tasks order. Backfilled 0; editor assigns.
    position: integer('position').notNull().default(0),
    // owner: legacy free-text display fallback ([Name] token); superseded by assigneeId.
    owner: text('owner'),
    done: boolean('done').notNull().default(false),
    createdBy: text('created_by'), // attribution; access derives from the home tab's board
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Auto-bumped by a BEFORE UPDATE trigger (see migration) so every write path is covered.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tasks_home_tab_idx').on(t.homeTabId),
    index('tasks_assignee_idx').on(t.assigneeId),
  ],
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

// Personal time-blocking layer (the Planner). A block is OWNED by `user_id` (who
// scheduled it) and REFERENCES a tab/board it allocates time to — a LIVE projection of
// that board's tasks, never a frozen copy (hence no block↔task join). Visible to every
// member of `tab_id` (team "who's-on-what-today"); writable only by the owner. `filter`
// is an optional saved Filter (jsonb) narrowing the projected task list; `assignee_id`
// optionally scopes it to one member.
export const timeBlocks = pgTable(
  'time_blocks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tabId: text('tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // 'YYYY-MM-DD' — the day the block sits on
    start: text('start'), // 'HH:MM' (nullable = all-day / unscheduled)
    end: text('end'),
    label: text('label'),
    filter: jsonb('filter'), // optional saved Filter projection
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('time_blocks_user_date_idx').on(t.userId, t.date),
    index('time_blocks_tab_idx').on(t.tabId),
  ],
);

// (Retired) The Today aggregation tab's blocks/snapshots were dropped in migration
// 0006 when the Planner (time_blocks) replaced them.

// Self-serve password reset tokens. Short-lived, single-use (usedAt set on redemption).
// Cascade-deleted with the user. See AUTH_IMPLEMENTATION_PLAN.md (Slice 4).
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    token: text('token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('password_reset_user_idx').on(t.userId)],
);

// Per-member board presence — ONE row per (board, member). Powers the "seen by / edited
// by + time" activity strip next to a board. `lastSeenAt` is bumped by a lightweight
// client beacon when a member opens the board; `lastEditedAt` is bumped (fire-and-forget)
// whenever a member makes a successful write to it. NOT the audit log: this is a compact,
// upsert-in-place presence layer, not an append-only trail. See AUTH_IMPLEMENTATION_PLAN.md.
export const boardActivity = pgTable(
  'board_activity',
  {
    tabId: text('tab_id')
      .notNull()
      .references(() => tabs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastEditedAt: timestamp('last_edited_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tabId, t.userId] }),
    index('board_activity_tab_idx').on(t.tabId),
  ],
);

// Append-only audit trail. `actorId` is intentionally NOT a foreign key: erasing a user
// must PSEUDONYMIZE (not cascade-delete) their trail, and unauthenticated attempts log a
// null actor. Routine content edits write a COARSE row (payload null, high volume from the
// persist path); security/structural events write FULL (redacted) detail. Only the
// retention prune deletes rows. See AUTH_IMPLEMENTATION_PLAN.md (Slice 2).
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id'), // NO fk — see note above
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    method: text('method'),
    payload: jsonb('payload'), // null for coarse rows
    status: integer('status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);
