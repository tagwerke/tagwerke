// Thin HTTP client for the Tagwerke backend. All calls are same-origin (Vite proxies
// /api -> the Fastify server) and carry the session cookie.
//
// Offline-critical mutations (tasks, tab docs, projects, tabs, time blocks) are
// funneled through a DURABLE, ordered outbox (see src/offline/outbox.ts) so edits
// made offline survive a reload and replay on reconnect. Reads, plus the
// collaboration/admin endpoints that need a live response (members, events, admin),
// stay as direct fetches and simply fail while offline.

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import type { ID, TaskStatus, TimeBlock } from '../types';
import { submitMutation, outboxIdle, setConflictHandler, type Mutation } from '../offline/outbox';
import { offline } from '../offline/status';

async function req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      credentials: 'include',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch (e) {
    offline.setOnline(false); // network unreachable
    throw e;
  }
  offline.setOnline(true);
  if (!r.ok) {
    let detail = '';
    try {
      detail = (await r.json())?.error ?? '';
    } catch {
      /* ignore */
    }
    throw new ApiError(r.status, `${init?.method ?? 'GET'} ${path} -> ${r.status} ${detail}`);
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---- write path: durable outbox ------------------------------------------
const M = (method: Mutation['method'], path: string, body?: unknown): Mutation => ({ method, path, body });

/** After a server-rejected (4xx) write the session re-pulls authoritative state. */
export function setWriteErrorHandler(fn: () => void): void {
  setConflictHandler(fn);
}

/** Back-compat shim: store/persist call `enqueue(() => api.X.Y(...))`; the api
 *  mutation methods already submit to the durable outbox, so this just invokes
 *  the thunk. Ordering + retry + persistence now live in the outbox. */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/** Resolves once all queued writes have settled (used before reads that must see them). */
export function drain(): Promise<void> {
  return outboxIdle();
}

// ---- auth ----------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
  totpEnabled: boolean;
}

export const auth = {
  signup: (email: string, password: string, inviteCode: string) =>
    req<{ user: SessionUser }>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, inviteCode }) }),
  // Returns `{ user }` on success, or `{ totpRequired: true }` when a 2FA code is needed.
  login: (email: string, password: string, totp?: string) =>
    req<{ user?: SessionUser; totpRequired?: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, totp }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  me: () => req<{ user: SessionUser }>('/api/me'),
  forgot: (email: string) => req('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) }),
  reset: (token: string, password: string) =>
    req('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) }),
  // MFA / TOTP (authenticated).
  totpEnroll: () =>
    req<{ secret: string; otpauthUrl: string; qr: string; backupCodes: string[] }>('/api/auth/totp/enroll', { method: 'POST' }),
  totpVerify: (code: string) => req('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  totpDisable: (code: string) => req('/api/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  // SSO: tells the login screen whether to show the button (no secrets).
  oidcPublic: () => req<OidcPublic>('/api/auth/oidc/public'),
  // Passkeys (WebAuthn). The ceremonies wrap @simplewebauthn/browser.
  passkey: {
    list: () => req<{ passkeys: PasskeyInfo[] }>('/api/auth/passkey'),
    rename: (id: ID, nickname: string) => req(`/api/auth/passkey/${id}`, { method: 'PATCH', body: JSON.stringify({ nickname }) }),
    remove: (id: ID) => req(`/api/auth/passkey/${id}`, { method: 'DELETE' }),
    register: async (nickname?: string) => {
      const options = await req<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/passkey/register/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      return req('/api/auth/passkey/register/verify', { method: 'POST', body: JSON.stringify({ response, nickname }) });
    },
    login: async () => {
      const options = await req<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/passkey/login/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      return req<{ user: SessionUser }>('/api/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify({ response }) });
    },
    // Conditional-UI (autofill) login — resolves when the user picks a passkey from the field.
    loginConditional: async () => {
      const options = await req<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/passkey/login/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: true });
      return req<{ user: SessionUser }>('/api/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify({ response }) });
    },
  },
};

export interface OidcPublic {
  enabled: boolean;
  buttonLabel: string;
  passwordDisabled: boolean;
}
export interface PasskeyInfo {
  id: ID;
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
}
export interface OidcConfig {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  allowedDomain?: string;
  buttonLabel?: string;
}
export interface OrgConfig {
  oidc?: OidcConfig;
  ssoOnly?: boolean;
}

export const getState = () => req('/api/state');

// ---- mutations (raw; callers usually wrap in enqueue) ---------------------

export const api = {
  // ── Offline-critical mutations → durable outbox (optimistic, replayed) ──────
  projects: {
    create: (b: { id: ID; name: string; color: string; position: number }) =>
      submitMutation(M('POST', '/api/projects', b)),
    update: (id: ID, patch: { name?: string; color?: string }) =>
      submitMutation(M('PATCH', `/api/projects/${id}`, patch)),
    remove: (id: ID) => submitMutation(M('DELETE', `/api/projects/${id}`)),
    reorder: (order: ID[]) => submitMutation(M('POST', '/api/projects/reorder', { order })),
  },
  tabs: {
    create: (b: { id: ID; projectId: ID; name: string; position: number; starred?: boolean; type?: string }) =>
      submitMutation(M('POST', '/api/tabs', b)),
    // The board document is no longer PATCH-saved — it syncs as a Yjs CRDT over the socket
    // (yProvider.ts) and is persisted server-side (server/realtime/ydoc.ts). This `update` is
    // for board metadata (name/category/star/date/settings) only.
    update: (
      id: ID,
      patch: { name?: string; projectId?: ID; starred?: boolean; starredPosition?: number | null; dateKey?: string | null; location?: string | null; settings?: { requireReview?: boolean; restrictDelete?: 'admin' | null } },
    ) => submitMutation(M('PATCH', `/api/tabs/${id}`, patch)),
    remove: (id: ID) => submitMutation(M('DELETE', `/api/tabs/${id}`)),
    reorder: (order: ID[]) => submitMutation(M('POST', '/api/tabs/reorder', { order })),
    reorderStarred: (order: ID[]) => submitMutation(M('POST', '/api/tabs/reorder-starred', { order })),
  },
  tasks: {
    upsert: (id: ID, b: { homeTabId: ID; text: string; status?: TaskStatus; assigneeId?: ID | null; reviewerId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
      submitMutation(M('PUT', `/api/tasks/${id}`, b)),
    patch: (id: ID, patch: { text?: string; status?: TaskStatus; assigneeId?: ID | null; reviewerId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
      submitMutation(M('PATCH', `/api/tasks/${id}`, patch)),
    remove: (id: ID) => submitMutation(M('DELETE', `/api/tasks/${id}`)),
    deleteOrphans: (homeTabId: ID, keepIds: ID[]) =>
      submitMutation(M('POST', '/api/tasks/delete-orphans', { homeTabId, keepIds })),
  },
  timeBlocks: {
    // Day/week read: own + teammates' blocks on shared boards, within [from, to]. (read → live)
    list: (from: string, to: string) =>
      req<{ blocks: TimeBlockOut[]; roster: { userId: ID; email: string }[] }>(
        `/api/time-blocks?from=${from}&to=${to}`,
      ),
    create: (b: TimeBlock) => submitMutation(M('POST', '/api/time-blocks', b)),
    update: (id: ID, patch: Partial<Omit<TimeBlock, 'id' | 'userId'>>) =>
      submitMutation(M('PATCH', `/api/time-blocks/${id}`, patch)),
    remove: (id: ID) => submitMutation(M('DELETE', `/api/time-blocks/${id}`)),
    reorder: (order: ID[]) => submitMutation(M('POST', '/api/time-blocks/reorder', { order })),
  },
  members: {
    list: (tabId: ID) => req<{ members: BoardMember[] }>(`/api/tabs/${tabId}/members`),
    add: (tabId: ID, email: string, role: BoardRole) =>
      req<{ ok: boolean; userId: ID }>(`/api/tabs/${tabId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    setRole: (tabId: ID, userId: ID, role: BoardRole) =>
      req(`/api/tabs/${tabId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    remove: (tabId: ID, userId: ID) => req(`/api/tabs/${tabId}/members/${userId}`, { method: 'DELETE' }),
  },
  events: {
    list: (tabId: ID) => req<{ events: BoardEvent[]; roster: { userId: ID; email: string }[] }>(`/api/tabs/${tabId}/events`),
    create: (tabId: ID, b: { start?: string | null; end?: string | null; rrule?: string | null }) =>
      req<{ ok: boolean; id: ID }>(`/api/tabs/${tabId}/events`, { method: 'POST', body: JSON.stringify(b) }),
    update: (eventId: ID, patch: { start?: string | null; end?: string | null; rrule?: string | null }) =>
      req(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (eventId: ID) => req(`/api/events/${eventId}`, { method: 'DELETE' }),
    rsvp: (eventId: ID, occurrenceDate: string, status: AttendanceStatus) =>
      req(`/api/events/${eventId}/attendance`, { method: 'PUT', body: JSON.stringify({ occurrenceDate, status }) }),
  },
  activity: {
    // Board presence: who has seen/edited the board and when (read → live).
    get: (tabId: ID) => req<{ activity: BoardActivityRow[] }>(`/api/tabs/${tabId}/activity`),
    // Beacon: mark myself present on the board. Best-effort — swallow errors so a failed
    // ping never surfaces to the user.
    seen: (tabId: ID) => req(`/api/tabs/${tabId}/seen`, { method: 'POST' }).catch(() => undefined),
  },
  history: {
    // Per-object change timeline (Layer A). Editor+ on the item's board (read → live).
    task: (id: ID) => req<{ entries: HistoryEntry[] }>(`/api/tasks/${id}/history`),
    tab: (id: ID) => req<{ entries: HistoryEntry[] }>(`/api/tabs/${id}/history`),
  },
  trash: {
    // A board's soft-deleted tasks + restore (recoverability, §G). Editor+ (read/act → live).
    list: (tabId: ID) => req<{ tasks: TrashedTask[] }>(`/api/tabs/${tabId}/trash`),
    restore: (id: ID) => req(`/api/tasks/${id}/restore`, { method: 'POST' }),
  },
  admin: {
    users: () => req<{ users: AdminUser[] }>('/api/admin/users'),
    invites: () => req<{ invites: AdminInvite[] }>('/api/admin/invites'),
    createInvite: (b: { maxUses?: number; days?: number | null; note?: string | null }) =>
      req<AdminInvite>('/api/admin/invites', { method: 'POST', body: JSON.stringify(b) }),
    revokeInvite: (code: string) => req(`/api/admin/invites/${code}`, { method: 'DELETE' }),
    setRole: (id: ID, role: 'admin' | 'member') =>
      req(`/api/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    setActive: (id: ID, active: boolean) =>
      req(`/api/admin/users/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    orgConfig: () => req<{ config: OrgConfig }>('/api/org/config'),
    setOrgConfig: (patch: OrgConfig) => req('/api/org/config', { method: 'PATCH', body: JSON.stringify(patch) }),
    audit: (p: AuditParams = {}) =>
      req<{ entries: AuditEntry[]; nextCursor: string | null }>(`/api/admin/audit?${auditQuery(p)}`),
    // Step-up ("sudo"): status doubles as the admin probe (404 ⇒ not an admin).
    sudoStatus: () => req<{ active: boolean }>('/api/admin/sudo'),
    sudo: (creds: { password?: string; totp?: string }) =>
      req('/api/admin/sudo', { method: 'POST', body: JSON.stringify(creds) }),
    // Elevate via a passkey (for admins who signed in with SSO — no password/TOTP).
    sudoPasskey: async () => {
      const options = await req<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/admin/sudo/passkey/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      return req('/api/admin/sudo/passkey/verify', { method: 'POST', body: JSON.stringify({ response }) });
    },
    // Recovery: unlock a user who lost their 2FA / all their passkeys.
    resetTwoFactor: (id: ID) => req(`/api/admin/users/${id}/reset-2fa`, { method: 'POST' }),
    resetPasskeys: (id: ID) => req(`/api/admin/users/${id}/reset-passkeys`, { method: 'POST' }),
  },
};

export interface AuditParams {
  limit?: number;
  cursor?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
  category?: 'all' | 'security';
}
export interface AuditEntry {
  id: ID;
  actorId: ID | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  scopeId: string | null;
  method: string | null;
  status: number | null;
  createdAt: string;
  payload: unknown;
}

/** One row of a per-object history timeline (Layer A). Actor-scoped projection of the audit log. */
export interface HistoryEntry {
  id: ID;
  actorId: ID | null;
  actorEmail: string | null;
  action: string;
  payload: unknown;
  createdAt: string;
}

/** A trashed (soft-deleted) task shown in the Trash view. */
export interface TrashedTask {
  id: ID;
  text: string;
  lastTitle: string | null; // retained non-empty title, for tasks emptied before deletion
  status: string;
  assigneeId: ID | null;
  deletedAt: string | null;
  deletedBy: ID | null;
  deleterEmail: string | null;
}

function auditQuery(p: AuditParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') qs.set(k, String(v));
  return qs.toString();
}

/** URL for a filtered audit export download (browser GETs it directly with the session cookie). */
export function auditExportUrl(format: 'csv' | 'ndjson', p: AuditParams = {}): string {
  const qs = new URLSearchParams({ format });
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') qs.set(k, String(v));
  return `/api/admin/audit/export?${qs.toString()}`;
}

export interface BoardActivityRow {
  userId: ID;
  email: string;
  lastSeenAt: string | null;
  lastEditedAt: string | null;
}

export type BoardRole = 'viewer' | 'editor' | 'admin';
export interface BoardMember {
  userId: ID;
  email: string;
  role: BoardRole;
}

/** A time block as returned by the day/week read (nullable facets straight from the row). */
export interface TimeBlockOut {
  id: ID;
  userId: ID;
  tabId: ID;
  date: string;
  start: string | null;
  end: string | null;
  label: string | null;
  filter: unknown | null;
  assigneeId: ID | null;
  position: number;
}

export type AttendanceStatus = 'accepted' | 'declined' | 'tentative' | 'needs-action';
export interface BoardEvent {
  id: ID;
  start: string | null;
  end: string | null;
  rrule: string | null;
  occurrences: { date: string; attendance: { userId: ID; status: AttendanceStatus }[] }[];
}
export interface AdminUser {
  id: ID;
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
  deactivatedAt: string | null;
}
export interface AdminInvite {
  code: string;
  createdAt?: string;
  expiresAt: string | null;
  maxUses: number;
  usedCount?: number;
  note: string | null;
}
