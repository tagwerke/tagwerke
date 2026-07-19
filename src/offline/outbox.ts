// Durable, ordered mutation queue — the spine of offline write support.
//
// Every offline-critical write (tasks, tab docs, projects, tabs, time blocks) is
// recorded here as a serializable {method, path, body} descriptor, persisted to
// IndexedDB, and flushed to the server FIFO. The store stays the local source of
// truth (optimistic); the outbox is just how those edits reach the server.
//
// Error policy:
//   network error / 5xx → transient: keep the op, stop, retry on reconnect/backoff.
//   4xx                 → the server rejected it: drop the op (poison) and ask the
//                         session to re-pull authoritative state (matches the prior
//                         repull-on-write-failure behaviour).
//
// At-least-once delivery: the server's writes are PUT/PATCH/DELETE (idempotent) or
// id-carrying POSTs, and any divergence is reconciled by the conflict re-pull.

import { outboxAdd, outboxAll, outboxDelete, outboxClear } from './idb';
import { offline } from './status';
import { dlog } from '../util/dlog';

export interface Mutation {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * Optional in-memory response handlers for a mutation. NOT persisted to IndexedDB (they're
 * live closures) — an op replayed from a prior offline session loses them, which is fine:
 * app re-init re-pulls authoritative state. Used by the doc save to capture the new version
 * (onOk) and run a doc-specific conflict reconcile (onConflict) instead of the blunt repull.
 */
export interface Handlers {
  onOk?: (body: unknown) => void;
  onConflict?: (body: unknown) => void;
}

interface Pending {
  op: Mutation;
  handlers?: Handlers;
  resolve?: () => void;
  /** Resolves to the IDB row key once persisted, so we can delete exactly that row. */
  persisted: Promise<number | undefined>;
}

const queue: Pending[] = [];
let running = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;
let idleWaiters: Array<() => void> = [];
let conflict: (() => void) | null = null;

/** Register the handler that re-pulls authoritative state after a rejected (4xx) write. */
export function setConflictHandler(fn: () => void): void {
  conflict = fn;
}

function syncPending(): void {
  offline.setPending(queue.length);
  if (queue.length === 0) {
    const w = idleWaiters;
    idleWaiters = [];
    w.forEach((r) => r());
  }
}

/** Resolves when the queue has fully drained (used before reads that must see writes). */
export function outboxIdle(): Promise<void> {
  if (queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * Task ids that still have an un-acked mutation in the queue. Callers use this to protect an
 * optimistic local edit from being clobbered by a resync/hydrate (or a self-echo) that hasn't
 * seen the write yet — the local value wins until the server confirms it and the op leaves the
 * queue. Matches the per-task routes (`PUT|PATCH|DELETE /api/tasks/:id`) only.
 */
export function pendingTaskIds(): Set<string> {
  const ids = new Set<string>();
  for (const p of queue) {
    const m = /^\/api\/tasks\/([^/]+)$/.exec(p.op.path);
    if (m && m[1] !== 'delete-orphans') ids.add(m[1]);
  }
  return ids;
}

type SendResult = 'ok' | 'conflict' | 'transient' | 'handled';

async function send(op: Mutation, handlers?: Handlers): Promise<SendResult> {
  dlog('outbox', `send → ${op.method} ${op.path}`);
  let r: Response;
  try {
    r = await fetch(op.path, {
      method: op.method,
      credentials: 'include',
      headers: op.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: op.body !== undefined ? JSON.stringify(op.body) : undefined,
    });
  } catch {
    return 'transient'; // network unreachable
  }
  let body: unknown;
  try {
    const text = await r.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body — leave undefined */
  }
  dlog('outbox', `resp ← ${op.method} ${op.path} status=${r.status}`);
  if (r.ok) {
    handlers?.onOk?.(body);
    return 'ok';
  }
  if (r.status >= 500) return 'transient'; // server down/restarting → retry
  // 4xx: if this op brought its own conflict handler (doc save), let it reconcile and treat
  // the op as handled — do NOT trigger the generic drop-everything repull.
  if (handlers?.onConflict) {
    handlers.onConflict(body);
    return 'handled';
  }
  return 'conflict'; // 4xx → poison; drop + re-pull
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 3000, 30000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pump();
  }, retryDelay);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  offline.setSyncing(queue.length > 0);
  try {
    while (queue.length) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        offline.setOnline(false);
        break;
      }
      const head = queue[0];
      const result = await send(head.op, head.handlers);

      if (result === 'transient') {
        offline.setOnline(false);
        scheduleRetry();
        break;
      }

      // ok, conflict, or handled → the op leaves the queue.
      queue.shift();
      const seq = await head.persisted;
      if (seq != null) await outboxDelete(seq);
      head.resolve?.();
      retryDelay = 0;
      offline.setOnline(true);
      syncPending();
      // Only the GENERIC 4xx (no per-op handler) triggers the blunt state repull; a
      // 'handled' conflict was reconciled by the op's own onConflict.
      if (result === 'conflict') conflict?.();
    }
  } finally {
    running = false;
    offline.setSyncing(false);
    syncPending();
  }
}

/** Enqueue a mutation durably and kick the flush. Resolves once the op has been sent.
 *  `handlers` (in-memory only) let a caller observe the response — see {@link Handlers}. */
export function submitMutation(op: Mutation, handlers?: Handlers): Promise<void> {
  return new Promise<void>((resolve) => {
    // Push synchronously so in-memory order is authoritative; persist in parallel.
    queue.push({ op, handlers, resolve, persisted: outboxAdd(op) });
    syncPending();
    void pump();
  });
}

/** Drop all pending ops (on logout — they belong to the departing user). */
export function clearOutbox(): void {
  queue.length = 0;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  void outboxClear();
  syncPending();
}

let started = false;

/** Load any persisted ops (from a prior offline session) and wire connectivity events.
 *  Idempotent — safe under React StrictMode's double-invoked effects. */
export async function startOutbox(): Promise<void> {
  if (started) return;
  started = true;
  const rows = await outboxAll<Mutation>();
  for (const row of rows.sort((a, b) => a.seq - b.seq)) {
    queue.push({ op: row.op, persisted: Promise.resolve(row.seq) });
  }
  syncPending();

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      offline.setOnline(true);
      retryDelay = 0;
      void pump();
    });
    window.addEventListener('offline', () => offline.setOnline(false));
  }
  void pump();
}
