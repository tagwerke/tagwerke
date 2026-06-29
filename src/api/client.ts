// Thin HTTP client for the do-app backend. All calls are same-origin (Vite proxies
// /api -> the Fastify server) and carry the session cookie.
//
// Offline-critical mutations (tasks, tab docs, projects, tabs, time blocks) are
// funneled through a DURABLE, ordered outbox (see src/offline/outbox.ts) so edits
// made offline survive a reload and replay on reconnect. Reads, plus the
// collaboration/admin endpoints that need a live response (members, events, admin),
// stay as direct fetches and simply fail while offline.

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
}

export const auth = {
  signup: (email: string, password: string, inviteCode: string) =>
    req<{ user: SessionUser }>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, inviteCode }) }),
  login: (email: string, password: string) =>
    req<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  me: () => req<{ user: SessionUser }>('/api/me'),
};

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
    update: (
      id: ID,
      patch: { name?: string; projectId?: ID; starred?: boolean; starredPosition?: number | null; dateKey?: string | null; docJSON?: unknown; location?: string | null },
    ) => submitMutation(M('PATCH', `/api/tabs/${id}`, patch)),
    remove: (id: ID) => submitMutation(M('DELETE', `/api/tabs/${id}`)),
    reorder: (order: ID[]) => submitMutation(M('POST', '/api/tabs/reorder', { order })),
    reorderStarred: (order: ID[]) => submitMutation(M('POST', '/api/tabs/reorder-starred', { order })),
  },
  tasks: {
    upsert: (id: ID, b: { homeTabId: ID; text: string; status?: TaskStatus; assigneeId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
      submitMutation(M('PUT', `/api/tasks/${id}`, b)),
    patch: (id: ID, patch: { text?: string; status?: TaskStatus; assigneeId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
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
  admin: {
    users: () => req<{ users: AdminUser[] }>('/api/admin/users'),
    invites: () => req<{ invites: AdminInvite[] }>('/api/admin/invites'),
    createInvite: (b: { maxUses?: number; days?: number | null; note?: string | null }) =>
      req<AdminInvite>('/api/admin/invites', { method: 'POST', body: JSON.stringify(b) }),
    revokeInvite: (code: string) => req(`/api/admin/invites/${code}`, { method: 'DELETE' }),
    setRole: (id: ID, role: 'admin' | 'member') =>
      req(`/api/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  },
};

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
}
export interface AdminInvite {
  code: string;
  createdAt?: string;
  expiresAt: string | null;
  maxUses: number;
  usedCount?: number;
  note: string | null;
}
