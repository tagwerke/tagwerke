// Realtime client (live updates, C1 + C2). One WebSocket to /api/ws, authenticated by the
// session cookie on the Upgrade. Subscribes to the open board's channel and applies peers'
// mutations to the store live.
//
// Two hard rules:
//   1. Never echo. A remote mutation is applied inside applyRemote(), which flushes local
//      pending edits first, then advances the persistence baseline so the applied change is
//      NOT re-sent to the server (which would loop back as another broadcast).
//   2. Forward-compatible envelope. Every message is { v, type, ... }; unknown types are
//      ignored so future CRDT/awareness frames don't need client changes (CRDT_SEAMS.md).
//
// Step 2 scope: task entity ops (status/assignee/text/priority/date/new task/delete). The
// 'doc' invalidation is received but not yet applied — that's step 3 (C2 doc + C3 reconcile).

import { useStore } from '../store';
import { flush, suspendPersistence, resumePersistence, setBaseline } from '../api/persist';
import { pendingTaskIds } from '../offline/outbox';
import type { ID, Task } from '../types';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

interface StartOpts {
  /** Re-pull authoritative state after a reconnect, to catch changes missed while down. */
  onResync: () => void;
}

let socket: WebSocket | null = null;
let opts: StartOpts | null = null;
let ready = false;
let stopped = true;
let hadConnection = false; // distinguishes first connect from a reconnect (→ resync)
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let subscribedBoard: ID | null = null;
let unsubStore: (() => void) | null = null;

// CRDT co-editing rooms multiplexed over this same socket (see yProvider.ts). The transport
// lives here; the Yjs protocol lives in the provider. A room registers a client to receive its
// frames; on every (re)connect we re-drive onReady() so it re-joins and resyncs.
export interface YdocRoomClient {
  onFrame(dataB64: string): void; // an inbound { type:'ydoc' } payload for this board
  onSeed(docJSON: unknown): void; // server granted a one-time legacy seed
  onReady(): void; // socket is (re)connected & ready → (re)join + resync
}
const ydocRooms = new Map<ID, YdocRoomClient>();

export function registerYdocRoom(tabId: ID, client: YdocRoomClient): void {
  ydocRooms.set(tabId, client);
  if (ready) client.onReady(); // socket already up → join right away
}
export function unregisterYdocRoom(tabId: ID): void {
  if (ydocRooms.delete(tabId)) sendJSON({ type: 'ydoc-leave', boardId: tabId });
}
export function joinYdocRoom(tabId: ID): void {
  sendJSON({ type: 'ydoc-join', boardId: tabId });
}
export function sendYdoc(tabId: ID, dataB64: string): void {
  sendJSON({ type: 'ydoc', boardId: tabId, data: dataB64 });
}

function wsUrl(): string {
  const u = new URL('/api/ws', window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function sendJSON(msg: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* dropped socket — reconnect handles it */
    }
  }
}

// --- subscription: follow the open board -----------------------------------------------

/** Reconcile the server-side board subscription with the store's active board. */
function syncSubscription(): void {
  if (!ready) return;
  const active = useStore.getState().activeTabId;
  if (active === subscribedBoard) return;
  if (subscribedBoard) sendJSON({ type: 'unsubscribe', boardId: subscribedBoard });
  if (active) sendJSON({ type: 'subscribe', boardId: active });
  subscribedBoard = active;
}

// --- applying remote mutations ---------------------------------------------------------

/**
 * Apply a remote store mutation without it echoing back to the server. Local pending edits
 * are flushed first (so they aren't lost), then the persistence baseline is advanced past
 * the applied change so the differ treats it as already-persisted.
 */
function applyRemote(mutate: () => void): void {
  flush(); // persist any pending local edits BEFORE we move the baseline
  suspendPersistence();
  try {
    mutate();
  } finally {
    setBaseline(useStore.getState());
    resumePersistence();
  }
}

const TASK_FIELDS = ['text', 'status', 'assigneeId', 'reviewerId', 'date', 'priority', 'position', 'homeTabId', 'owner'] as const;

/** Pick known Task fields from a wire patch; null → undefined (a cleared optional field). */
function normalizeTaskPatch(raw: unknown): Partial<Task> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TASK_FIELDS) {
    if (k in src) out[k] = src[k] === null ? undefined : src[k];
  }
  return out as Partial<Task>;
}

function applyEntity(msg: { entity?: string; id?: string; action?: string; patch?: unknown }): void {
  if (msg.entity !== 'task' || !msg.id) return; // step 2: tasks only; others ignored
  const id = msg.id;
  // A task with an un-acked local write wins until the server confirms it — ignore any remote or
  // echoed patch for it (the DB is already converging via the outbox). This is our self-echo
  // suppression, done client-side and idempotently, matching the resync's pending-preserve rule.
  if (pendingTaskIds().has(id)) return;
  const tasks = useStore.getState().tasks;

  if (msg.action === 'DELETE') {
    if (tasks[id]) applyRemote(() => useStore.getState().deleteTask(id));
    return;
  }

  const patch = normalizeTaskPatch(msg.patch);
  if (!patch) return;

  if (tasks[id]) {
    // Existing task → merge the changed fields; keep the derived `done` mirror in sync.
    applyRemote(() =>
      useStore.setState((s) => {
        const merged: Task = { ...s.tasks[id], ...patch, id, homeTabId: s.tasks[id].homeTabId };
        if (patch.status !== undefined) merged.done = patch.status === 'done';
        return { tasks: { ...s.tasks, [id]: merged } };
      }),
    );
  } else if (typeof patch.homeTabId === 'string' && typeof patch.text === 'string') {
    // New task (arrives as a full upsert body). Appears in entity-driven views (planner,
    // lists) immediately; it shows in the open board's document once doc sync lands (step 3).
    const homeTabId = patch.homeTabId;
    const text = patch.text;
    applyRemote(() => useStore.getState().upsertTask({ id, homeTabId, text, ...patch }));
  }
  // else: a partial patch for a task we don't have yet — skip; the next resync fills it in.
}

function handleMessage(raw: string): void {
  let msg: { v?: number; type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'ready':
      ready = true;
      subscribedBoard = null; // force a fresh subscribe for the current board
      syncSubscription();
      // Re-drive every open doc room so it re-joins (authz) and resyncs after a reconnect.
      for (const room of ydocRooms.values()) room.onReady();
      return;
    case 'ydoc': {
      const m = msg as { boardId?: string; data?: string };
      if (m.boardId && typeof m.data === 'string') ydocRooms.get(m.boardId)?.onFrame(m.data);
      return;
    }
    case 'ydoc-seed': {
      const m = msg as { boardId?: string; docJSON?: unknown };
      if (m.boardId) ydocRooms.get(m.boardId)?.onSeed(m.docJSON ?? null);
      return;
    }
    case 'entity':
      applyEntity(msg as { entity?: string; id?: string; action?: string; patch?: unknown });
      return;
    case 'board-list':
      // Our board access changed (added to / removed from / role changed on a board) — arrives
      // on our personal channel from the members routes. Re-pull authoritative state so the
      // sidebar reflects it without a manual refresh. Same mechanism as a reconnect resync.
      opts?.onResync();
      return;
    // The board document now syncs as a Yjs CRDT (type 'ydoc'/'ydoc-seed', handled above via
    // the ydocRooms registry). There is no 'doc' version-invalidation anymore.
    default:
      return; // unknown type — ignore (forward-compatible)
  }
}

// --- connection lifecycle --------------------------------------------------------------

function connect(): void {
  if (stopped) return;
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    // A reconnect (not the first connect) means we may have missed writes → resync.
    if (hadConnection) opts?.onResync();
    hadConnection = true;
  };
  socket.onmessage = (e) => handleMessage(String(e.data));
  socket.onclose = () => {
    ready = false;
    socket = null;
    scheduleReconnect();
  };
  socket.onerror = () => {
    // onclose follows and drives the reconnect.
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

/** Start the realtime connection. Idempotent. Reconnects until stopRealtime(). */
export function startRealtime(startOpts: StartOpts): void {
  if (!stopped) return;
  opts = startOpts;
  stopped = false;
  hadConnection = false;
  reconnectDelay = RECONNECT_MIN_MS;
  // Follow the open board as it changes.
  unsubStore = useStore.subscribe(syncSubscription);
  connect();
}

/** Tear the connection down (logout). */
export function stopRealtime(): void {
  stopped = true;
  ready = false;
  subscribedBoard = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (unsubStore) {
    unsubStore();
    unsubStore = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}
