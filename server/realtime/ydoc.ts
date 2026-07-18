// CRDT co-editing rooms (Yjs). Replaces the interim docVersion/409 conflict model for the
// document — see internal/planning/CRDT_SEAMS.md. One authoritative Y.Doc per board lives
// here in memory; clients sync to it over the existing /api/ws socket (ws.ts routes the
// 'ydoc'/'ydoc-join'/'ydoc-leave' envelope types to the handlers below).
//
// Key property: the server holds each Y.Doc OPAQUELY. Yjs is schema-agnostic, so we apply
// updates and persist state as bytes without ever reconstructing the TipTap/ProseMirror
// schema. We derive the render snapshot (tabs.docJSON) straight from the Yjs structure with
// y-prosemirror's yDocToProsemirrorJSON, which also needs no schema. The client keeps the
// schema (it seeds legacy docs and renders); the server just merges and persists.
//
// Transport: a Yjs message (the standard y-protocols sync/awareness binary, first varUint =
// messageSync|messageAwareness) is base64'd into { v, type:'ydoc', boardId, data }. It rides
// the JSON socket unchanged; fan-out is per-room to the exact ws set (room.conns), so origin
// exclusion is precise and Yjs traffic never touches the entity/invalidation bus.

import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

const PROTOCOL_VERSION = 1;
const messageSync = 0;
const messageAwareness = 1;
// The Y.XmlFragment name TipTap's Collaboration extension binds to (its `field` default).
const FRAGMENT = 'default';
// Kept short (robustness over write-frequency): the smaller this window, the fewer edits a hard
// SIGKILL can lose. Graceful restarts (deploys) lose nothing — flushAllYdocRooms() flushes on
// shutdown. See internal note on the task orphan bug (rows outliving their doc nodes).
const PERSIST_DEBOUNCE_MS = 400;

interface Room {
  tabId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  // ws -> the awareness client IDs that connection owns (for cleanup on disconnect).
  conns: Map<WebSocket, Set<number>>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persisting: boolean;
  // Seeding of a pre-CRDT document (legacy docJSON) into an empty Y.Doc happens on the client
  // (it has the schema). We grant it to exactly one connection so two openers can't double-seed.
  persistedState: boolean; // ydoc_state already existed / has been written → never seed again
  legacyDocJSON: unknown | null; // pre-CRDT content to seed from, if any
  seedClaimedBy: WebSocket | null;
  hasContent: boolean; // real content has flowed → seeding no longer needed
}

const rooms = new Map<string, Promise<Room>>();

function frame(ws: WebSocket, tabId: string, encoder: encoding.Encoder): void {
  const data = Buffer.from(encoding.toUint8Array(encoder)).toString('base64');
  try {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ydoc', boardId: tabId, data }));
  } catch {
    /* best-effort; a broken socket is cleaned up on its own close event */
  }
}

/** Send a Yjs message (already encoded) to every connection in the room except `except`. */
function broadcast(room: Room, encoder: encoding.Encoder, except: WebSocket | null): void {
  const data = Buffer.from(encoding.toUint8Array(encoder)).toString('base64');
  const payload = JSON.stringify({ v: PROTOCOL_VERSION, type: 'ydoc', boardId: room.tabId, data });
  for (const ws of room.conns.keys()) {
    if (ws === except) continue;
    try {
      ws.send(payload);
    } catch {
      /* best-effort */
    }
  }
}

async function loadRoom(tabId: string): Promise<Room> {
  const row = (
    await db
      .select({ ydocState: schema.tabs.ydocState, docJSON: schema.tabs.docJSON })
      .from(schema.tabs)
      .where(eq(schema.tabs.id, tabId))
      .limit(1)
  )[0];

  const doc = new Y.Doc();
  const persistedState = !!row?.ydocState;
  if (row?.ydocState) {
    // Apply the persisted state BEFORE wiring the update handler so the load itself isn't
    // treated as an edit (no re-persist, no phantom broadcast).
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(row.ydocState, 'base64')));
  }

  const room: Room = {
    tabId,
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Map(),
    persistTimer: null,
    persisting: false,
    persistedState,
    legacyDocJSON: row?.docJSON ?? null,
    seedClaimedBy: null,
    hasContent: persistedState,
  };
  // Server-local awareness state is meaningless; don't advertise the server as a peer.
  room.awareness.setLocalState(null);

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (room.doc.getXmlFragment(FRAGMENT).length > 0) room.hasContent = true;
    // Relay to every other participant as a sync-update message. `origin` is the ws that sent
    // the update (readSyncMessage sets it); exclude it so it doesn't get its own edit echoed.
    const originWs = origin && room.conns.has(origin as WebSocket) ? (origin as WebSocket) : null;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoder, originWs);
    schedulePersist(room);
  });

  room.awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const ws = origin as WebSocket | null;
      if (ws && room.conns.has(ws)) {
        const owned = room.conns.get(ws)!;
        for (const id of added) owned.add(id);
        for (const id of updated) owned.add(id);
        for (const id of removed) owned.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
      broadcast(room, encoder, ws && room.conns.has(ws) ? ws : null);
    },
  );

  return room;
}

function getRoom(tabId: string): Promise<Room> {
  let p = rooms.get(tabId);
  if (!p) {
    p = loadRoom(tabId);
    rooms.set(tabId, p);
  }
  return p;
}

function schedulePersist(room: Room): void {
  if (room.persistTimer) return;
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    void persist(room);
  }, PERSIST_DEBOUNCE_MS);
}

// The actual DB write of a room's current state. No debounce/in-flight guard — callers own that.
async function writeState(room: Room): Promise<void> {
  // Never overwrite a not-yet-migrated legacy doc with an empty snapshot. If the Y.Doc is still
  // empty and no real content has ever flowed through this room, there is nothing worth saving —
  // and persisting would clobber the legacy `docJSON` that seeding still needs to read.
  if (!room.hasContent && room.doc.getXmlFragment(FRAGMENT).length === 0) return;

  const ydocState = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64');
  let docJSON: unknown = null;
  try {
    docJSON = yDocToProsemirrorJSON(room.doc, FRAGMENT);
  } catch {
    /* derive is best-effort; the authoritative ydocState always persists */
  }
  await db.update(schema.tabs).set({ ydocState, docJSON }).where(eq(schema.tabs.id, room.tabId));
  room.persistedState = true;

  // Additive existence backfill: guarantee a task ROW exists for every task NODE in the doc. Rows
  // are otherwise created only by the client's store→REST diff, which can silently fail (offline,
  // dropped request) — leaving a task visible in the board but missing from Kanban/My-Tasks. This
  // is the mirror of the durability fix and closes the node→row gap from the single authority that
  // already holds the doc. ON CONFLICT DO NOTHING makes it purely additive: it never touches an
  // existing row (so it can't overwrite metadata or resurrect a soft-deleted task) and never
  // deletes. Best-effort — a failure here must not fail the doc persist above.
  if (docJSON) {
    try {
      await backfillRowsForDoc(room.tabId, docJSON);
    } catch (err) {
      console.error(`[ydoc] row backfill failed for ${room.tabId}:`, err);
    }
  }
}

/** Concatenated text of a taskItem's own first paragraph (its title line, excluding subtasks). */
function taskItemText(taskItem: { content?: unknown[] }): string {
  const para = (taskItem.content ?? []).find(
    (c): c is { type: string; content?: unknown[] } =>
      !!c && typeof c === 'object' && (c as { type?: string }).type === 'paragraph',
  );
  let text = '';
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      const node = n as { type?: string; text?: string; content?: unknown[] };
      if (node.type === 'text' && typeof node.text === 'string') text += node.text;
      else if (Array.isArray(node.content)) walk(node.content);
    }
  };
  if (para?.content) walk(para.content);
  return text;
}

/** Walk ProseMirror JSON collecting every taskItem's {id, text}. */
function collectTaskNodes(node: unknown, out: { id: string; text: string }[] = []): { id: string; text: string }[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
  if (n.type === 'taskItem' && n.attrs?.id) out.push({ id: n.attrs.id, text: taskItemText(n) });
  if (Array.isArray(n.content)) for (const c of n.content) collectTaskNodes(c, out);
  return out;
}

/** Insert a row for any doc task node that lacks one. Non-empty titles only (transient empty task
 *  lines aren't real tasks yet); the client creates those once typed. Idempotent + additive. */
async function backfillRowsForDoc(tabId: string, docJSON: unknown): Promise<void> {
  const values = collectTaskNodes(docJSON)
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ id: t.id, homeTabId: tabId, text: t.text }));
  if (!values.length) return;
  await db.insert(schema.tasks).values(values).onConflictDoNothing({ target: schema.tasks.id });
}

async function persist(room: Room): Promise<void> {
  if (room.persisting) {
    schedulePersist(room); // a write landed mid-flush; capture it on the next tick
    return;
  }
  room.persisting = true;
  try {
    await writeState(room);
  } catch (err) {
    console.error(`[ydoc] persist failed for ${room.tabId}:`, err);
  } finally {
    room.persisting = false;
  }
}

/**
 * Flush every open room's current state to the DB. Registered on graceful shutdown (SIGTERM/SIGINT
 * in server/index.ts) so in-memory Yjs edits sitting in the debounce window aren't lost when a
 * deploy/restart tears the process down while clients are still connected. This is the fix for the
 * orphan bug where task ROWS (written synchronously over REST) outlived their doc NODES (which lived
 * only in this debounced in-memory snapshot). Best-effort per room so one failure can't block exit.
 */
export async function flushAllYdocRooms(): Promise<number> {
  const pending = [...rooms.values()];
  let flushed = 0;
  await Promise.all(
    pending.map(async (p) => {
      let room: Room;
      try {
        room = await p;
      } catch {
        return; // room never finished loading; nothing to persist
      }
      if (room.persistTimer) {
        clearTimeout(room.persistTimer);
        room.persistTimer = null;
      }
      try {
        await writeState(room); // bypass the debounce guard: write the final state now, once.
        flushed++;
      } catch (err) {
        console.error(`[ydoc] shutdown flush failed for ${room.tabId}:`, err);
      }
    }),
  );
  return flushed;
}

// ── Reconcile engine (TASKS_AS_ENTITIES.md P4) ─────────────────────────────────────────────
// The invariant: for a board, exactly one task-ref atom in the doc IFF a live row homed to it.
// Because a ref is only an id (no content), both repairs are content-safe. This is what makes
// restore work — clearing deletedAt on a row is not enough; the doc must regain its ref. It also
// self-heals dropped creates / stale refs on board load.

/** Every taskItem id present in the board's Y.Doc. */
function collectDocRefIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem') {
        const id = child.getAttribute('id');
        if (id) ids.add(id);
      } else {
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return ids;
}

/** Append id-only task-ref atoms at the end of the doc (into the trailing taskList, or a new one). */
function appendRefs(doc: Y.Doc, ids: string[]): void {
  const frag = doc.getXmlFragment(FRAGMENT);
  const mk = (id: string): Y.XmlElement => {
    const el = new Y.XmlElement('taskItem');
    el.setAttribute('id', id);
    return el;
  };
  const last = frag.length ? frag.get(frag.length - 1) : null;
  if (last instanceof Y.XmlElement && last.nodeName === 'taskList') {
    last.push(ids.map(mk));
  } else {
    const list = new Y.XmlElement('taskList');
    list.push(ids.map(mk));
    frag.push([list]);
  }
}

/** Remove task-ref atoms with the given ids, and any taskList left empty by the removal. */
function pruneRefs(doc: Y.Doc, orphanIds: Set<string>): void {
  const frag = doc.getXmlFragment(FRAGMENT);
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = node.length - 1; i >= 0; i--) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem' && orphanIds.has(child.getAttribute('id') ?? '')) node.delete(i, 1);
      else walk(child);
    }
  };
  walk(frag);
  for (let i = frag.length - 1; i >= 0; i--) {
    const child = frag.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'taskList' && child.length === 0) frag.delete(i, 1);
  }
}

/**
 * Reconcile a board's doc refs with its live task rows: append a ref for every live row missing one
 * (restore / dropped create), prune every ref whose row is gone or trashed. Mutates the in-memory
 * Y.Doc (so connected editors get the change live over the socket) and persists. Safe to call with
 * no clients connected — the room is loaded, repaired, persisted, then released if still idle.
 */
export async function reconcileBoard(tabId: string): Promise<void> {
  const room = await getRoom(tabId);
  const liveRows = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.homeTabId, tabId), isNull(schema.tasks.deletedAt)));
  const liveIds = new Set(liveRows.map((r) => r.id));
  const docIds = collectDocRefIds(room.doc);

  const missing = [...liveIds].filter((id) => !docIds.has(id));
  const orphans = new Set([...docIds].filter((id) => !liveIds.has(id)));

  if (missing.length || orphans.size) {
    Y.transact(room.doc, () => {
      if (missing.length) appendRefs(room.doc, missing);
      if (orphans.size) pruneRefs(room.doc, orphans);
    });
    // doc.on('update') already fanned the change to connected editors; make sure it's durable now.
    await persist(room);
  }

  // If nobody is editing this board, don't leave the room resident in memory.
  if (room.conns.size === 0) {
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    rooms.delete(tabId);
    room.doc.destroy();
  }
}

// ── Public API (called from ws.ts) ────────────────────────────────────────────────────────

/** A client joined a board's document room. Registers the connection, starts the sync
 *  handshake, sends current awareness, and grants a one-time seed for legacy docs. */
export async function ydocJoin(tabId: string, ws: WebSocket): Promise<void> {
  const room = await getRoom(tabId);
  if (!room.conns.has(ws)) room.conns.set(ws, new Set());

  // Start sync: send our state vector so the client replies with what we're missing.
  const sync = encoding.createEncoder();
  encoding.writeVarUint(sync, messageSync);
  syncProtocol.writeSyncStep1(sync, room.doc);
  frame(ws, tabId, sync);

  // Send whatever awareness we already hold so the joiner sees existing cursors immediately.
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, messageAwareness);
    encoding.writeVarUint8Array(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    frame(ws, tabId, aw);
  }

  // Legacy migration: a document with pre-CRDT content but no Yjs state yet must be seeded
  // once, on the client (it has the schema). Grant to exactly one connection.
  if (!room.persistedState && !room.hasContent && room.legacyDocJSON != null && room.seedClaimedBy == null) {
    room.seedClaimedBy = ws;
    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ydoc-seed', boardId: tabId, docJSON: room.legacyDocJSON }));
    } catch {
      room.seedClaimedBy = null;
    }
  }
}

/** Handle an inbound Yjs frame (base64 of a y-protocols sync|awareness message). */
export async function ydocMessage(tabId: string, ws: WebSocket, dataB64: string): Promise<void> {
  const room = await getRoom(tabId);
  if (!room.conns.has(ws)) return; // must join first
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(dataB64, 'base64'));
  } catch {
    return;
  }
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case messageSync: {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      // Applies syncStep2/update onto room.doc (firing doc.on('update') → relay+persist) and
      // writes any reply (syncStep2 for a step1) into `encoder`. Origin = ws so the relay
      // excludes the sender.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
      if (encoding.length(encoder) > 1) frame(ws, tabId, encoder);
      return;
    }
    case messageAwareness: {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
      return;
    }
    default:
      return; // unknown Yjs message type — ignore
  }
}

/** A client left a board's document room (explicit leave or socket close). Drops its awareness
 *  states, releases an unfulfilled seed grant, and GCs the room when the last peer leaves. */
export async function ydocLeave(tabId: string, ws: WebSocket): Promise<void> {
  const p = rooms.get(tabId);
  if (!p) return;
  const room = await p;
  const owned = room.conns.get(ws);
  if (!owned) return;
  room.conns.delete(ws);
  if (owned.size > 0) {
    // Removing states fires awareness 'update' → peers see the cursor disappear.
    awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
  }
  if (room.seedClaimedBy === ws && !room.hasContent) room.seedClaimedBy = null;

  if (room.conns.size === 0) {
    // Last one out: flush pending state, then free the room from memory.
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
      await persist(room);
    }
    rooms.delete(tabId);
    room.doc.destroy();
  }
}

/** Remove a connection from every room it joined (called on socket close). */
export async function ydocDropConnection(ws: WebSocket): Promise<void> {
  for (const [tabId, p] of [...rooms]) {
    const room = await p;
    if (room.conns.has(ws)) await ydocLeave(tabId, ws);
  }
}
