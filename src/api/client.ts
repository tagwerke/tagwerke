// Thin HTTP client for the do-app backend. All calls are same-origin (Vite proxies
// /api -> the Fastify server) and carry the session cookie. Mutations are funneled
// through a single serialized queue so optimistic UI updates persist in order; on
// failure the registered error handler re-pulls authoritative state.

import type { ID, TaskStatus } from '../types';

async function req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
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

// ---- write serialization -------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
let onError: (() => void) | null = null;

export function setWriteErrorHandler(fn: () => void): void {
  onError = fn;
}

export function enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const next = chain.then(fn).catch((e) => {
    console.error('[api] write failed', e);
    onError?.();
    return undefined;
  });
  chain = next;
  return next;
}

/** Resolves once all queued writes have settled (used before reads that must see them). */
export function drain(): Promise<unknown> {
  return chain;
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
  projects: {
    create: (b: { id: ID; name: string; color: string; position: number }) =>
      req('/api/projects', { method: 'POST', body: JSON.stringify(b) }),
    update: (id: ID, patch: { name?: string; color?: string }) =>
      req(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: ID) => req(`/api/projects/${id}`, { method: 'DELETE' }),
    reorder: (order: ID[]) => req('/api/projects/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
  },
  tabs: {
    create: (b: { id: ID; projectId: ID; name: string; position: number; starred?: boolean; type?: string }) =>
      req('/api/tabs', { method: 'POST', body: JSON.stringify(b) }),
    update: (
      id: ID,
      patch: { name?: string; projectId?: ID; starred?: boolean; starredPosition?: number | null; dateKey?: string | null; docJSON?: unknown; location?: string | null },
    ) => req(`/api/tabs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: ID) => req(`/api/tabs/${id}`, { method: 'DELETE' }),
    reorder: (order: ID[]) => req('/api/tabs/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
    reorderStarred: (order: ID[]) => req('/api/tabs/reorder-starred', { method: 'POST', body: JSON.stringify({ order }) }),
  },
  tasks: {
    upsert: (id: ID, b: { homeTabId: ID; text: string; status?: TaskStatus; assigneeId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
      req(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    patch: (id: ID, patch: { text?: string; status?: TaskStatus; assigneeId?: ID | null; date?: string | null; priority?: 1 | 2 | 3 | null; position?: number; owner?: string | null; done?: boolean }) =>
      req(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: ID) => req(`/api/tasks/${id}`, { method: 'DELETE' }),
    deleteOrphans: (homeTabId: ID, keepIds: ID[]) =>
      req('/api/tasks/delete-orphans', { method: 'POST', body: JSON.stringify({ homeTabId, keepIds }) }),
  },
  blocks: {
    create: (b: { id: ID; homeTabId: ID; position: number }) =>
      req('/api/blocks', { method: 'POST', body: JSON.stringify(b) }),
    update: (id: ID, patch: { homeTabId?: ID; start?: string | null; end?: string | null; label?: string | null }) =>
      req(`/api/blocks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: ID) => req(`/api/blocks/${id}`, { method: 'DELETE' }),
    addTask: (blockId: ID, taskId: ID) =>
      req(`/api/blocks/${blockId}/tasks`, { method: 'POST', body: JSON.stringify({ taskId }) }),
    removeTask: (blockId: ID, taskId: ID) => req(`/api/blocks/${blockId}/tasks/${taskId}`, { method: 'DELETE' }),
    reorder: (order: ID[]) => req('/api/blocks/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
  },
  today: {
    freeze: (b: { snapshotId: ID; dateKey: string; docJSON: unknown }) =>
      req<{ snapshot: { id: ID; dateKey: string; createdAt: number; text: string } | null; nextDateKey?: string }>(
        '/api/today/freeze',
        { method: 'POST', body: JSON.stringify(b) },
      ),
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
