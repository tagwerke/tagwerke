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

export interface Mutation {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

interface Pending {
  op: Mutation;
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

async function send(op: Mutation): Promise<'ok' | 'conflict' | 'transient'> {
  try {
    const r = await fetch(op.path, {
      method: op.method,
      credentials: 'include',
      headers: op.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: op.body !== undefined ? JSON.stringify(op.body) : undefined,
    });
    if (r.ok) return 'ok';
    if (r.status >= 500) return 'transient'; // server down/restarting → retry
    return 'conflict'; // 4xx → poison; drop + re-pull
  } catch {
    return 'transient'; // network unreachable
  }
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
      const result = await send(head.op);

      if (result === 'transient') {
        offline.setOnline(false);
        scheduleRetry();
        break;
      }

      // ok or conflict → the op leaves the queue.
      queue.shift();
      const seq = await head.persisted;
      if (seq != null) await outboxDelete(seq);
      head.resolve?.();
      retryDelay = 0;
      offline.setOnline(true);
      syncPending();
      if (result === 'conflict') conflict?.();
    }
  } finally {
    running = false;
    offline.setSyncing(false);
    syncPending();
  }
}

/** Enqueue a mutation durably and kick the flush. Resolves once the op has been sent. */
export function submitMutation(op: Mutation): Promise<void> {
  return new Promise<void>((resolve) => {
    // Push synchronously so in-memory order is authoritative; persist in parallel.
    queue.push({ op, resolve, persisted: outboxAdd(op) });
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
