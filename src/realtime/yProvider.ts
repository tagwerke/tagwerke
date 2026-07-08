// Client-side Yjs provider, multiplexed over the existing app socket (see socket.ts). One
// instance per open board document. It speaks the standard y-protocols sync + awareness
// protocol, but instead of owning a WebSocket it registers as a room on the shared socket and
// exchanges base64'd frames. This keeps co-editing on the same authenticated connection as
// live updates — no second socket, no separate auth. See internal/planning/CRDT_SEAMS.md.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  registerYdocRoom,
  unregisterYdocRoom,
  joinYdocRoom,
  sendYdoc,
  type YdocRoomClient,
} from './socket';
import type { ID } from '../types';

const messageSync = 0;
const messageAwareness = 1;

function b64encode(encoder: encoding.Encoder): string {
  const bytes = encoding.toUint8Array(encoder);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A Yjs sync/awareness provider bound to one board's Y.Doc over the shared socket. TipTap's
 * CollaborationCaret reads `.awareness`; the Collaboration extension binds to the `doc`.
 */
export class YSocketProvider implements YdocRoomClient {
  readonly tabId: ID;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  synced = false;
  private pendingSeed: { docJSON: unknown } | null = null; // granted, awaiting sync
  private readySeed: { docJSON: unknown } | null = null; // synced + empty → ready to apply
  private seedListener: ((docJSON: unknown) => void) | null = null;
  private destroyed = false;

  /** The editor subscribes here; fired once with the legacy content to seed a pre-CRDT doc.
   *  A method (not a settable field) so the editor never mutates the provider directly. */
  onSeedReady(cb: (docJSON: unknown) => void): () => void {
    this.seedListener = cb;
    if (this.readySeed) cb(this.readySeed.docJSON); // grant already arrived → fire now
    return () => {
      if (this.seedListener === cb) this.seedListener = null;
    };
  }

  constructor(tabId: ID, doc: Y.Doc) {
    this.tabId = tabId;
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    // Remove our awareness state (peers stop seeing our cursor) if the tab/window goes away.
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.onUnload);
  }

  /** Register with the socket (idempotent). Kept OUT of the constructor so the room cache
   *  controls lifetime — otherwise React StrictMode's mount→unmount→remount would register in
   *  the constructor but the effect-cleanup destroy would tear it down and never re-register,
   *  leaving the editor bound to a dead provider that never syncs. */
  connect(): void {
    if (this.destroyed) return;
    registerYdocRoom(this.tabId, this); // drives onReady() immediately if the socket is up
  }

  // --- YdocRoomClient (called by socket.ts) --------------------------------------------

  onReady = (): void => {
    if (this.destroyed) return;
    this.synced = false;
    joinYdocRoom(this.tabId); // authz'd join; server replies with its own sync step 1
    // Start the sync handshake from our side too.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeSyncStep1(enc, this.doc);
    sendYdoc(this.tabId, b64encode(enc));
    // (Re)advertise our cursor after a (re)connect.
    if (this.awareness.getLocalState()) this.sendAwareness([this.doc.clientID]);
  };

  onFrame = (dataB64: string): void => {
    if (this.destroyed) return;
    const decoder = decoding.createDecoder(b64decode(dataB64));
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1) sendYdoc(this.tabId, b64encode(encoder));
        // Receiving the server's state (step 2) means our doc is now current.
        if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) this.markSynced();
        return;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        return;
      }
      default:
        return;
    }
  };

  onSeed = (docJSON: unknown): void => {
    // The server offered a one-time seed of legacy content. Apply only once synced (so we know
    // the doc is genuinely empty, not just not-yet-received). Defer if not synced yet.
    if (this.synced) this.applySeed(docJSON);
    else this.pendingSeed = { docJSON };
  };

  // --- internals -----------------------------------------------------------------------

  private markSynced(): void {
    this.synced = true;
    if (this.pendingSeed) {
      const { docJSON } = this.pendingSeed;
      this.pendingSeed = null;
      this.applySeed(docJSON);
    }
  }

  private applySeed(docJSON: unknown): void {
    // Only seed a still-empty doc — a peer may have populated it in the meantime.
    if (this.doc.getXmlFragment('default').length > 0) return;
    this.readySeed = { docJSON };
    this.seedListener?.(docJSON);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Skip updates we ourselves applied from the network (origin === this); only send local edits.
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeUpdate(enc, update);
    sendYdoc(this.tabId, b64encode(enc));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    // Only forward OUR cursor changes; remote-applied awareness (origin === this provider) is
    // not echoed back. Local mutations from the Awareness class carry origin 'local'.
    if (origin !== 'local') return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  private sendAwareness(clients: number[]): void {
    if (clients.length === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageAwareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    sendYdoc(this.tabId, b64encode(enc));
  }

  private onUnload = (): void => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
  };

  destroy(): void {
    this.destroyed = true;
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.onUnload);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    // Tell peers our cursor is gone, then leave the room (server drops us + GCs if last out).
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.awareness.destroy();
    unregisterYdocRoom(this.tabId);
  }
}

// ── Per-board room cache ────────────────────────────────────────────────────────────────────
// The Y.Doc + provider for a board must outlive React StrictMode's mount→unmount→remount churn
// and any transient editor re-creation. So they live in a module cache, created lazily on first
// use and destroyed only after the last user leaves — with a short defer so an immediate remount
// (StrictMode) or fast tab re-open reuses the SAME live, already-synced room.

interface CachedRoom {
  doc: Y.Doc;
  provider: YSocketProvider;
  refs: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
}

const roomCache = new Map<ID, CachedRoom>();
const DESTROY_DELAY_MS = 2000;

/** Get (creating + connecting on first use) the shared room for a board. Cancels any pending
 *  teardown. Does NOT change the refcount — call retainYRoom in an effect for that. */
export function acquireYRoom(tabId: ID): { doc: Y.Doc; provider: YSocketProvider } {
  let r = roomCache.get(tabId);
  if (!r) {
    const doc = new Y.Doc();
    const provider = new YSocketProvider(tabId, doc);
    r = { doc, provider, refs: 0, destroyTimer: null };
    roomCache.set(tabId, r);
    provider.connect();
  }
  if (r.destroyTimer) {
    clearTimeout(r.destroyTimer);
    r.destroyTimer = null;
  }
  return { doc: r.doc, provider: r.provider };
}

/** Mark one live user of the board's room (call in an effect that pairs with releaseYRoom). */
export function retainYRoom(tabId: ID): void {
  const r = roomCache.get(tabId);
  if (!r) return;
  r.refs++;
  if (r.destroyTimer) {
    clearTimeout(r.destroyTimer);
    r.destroyTimer = null;
  }
}

/** Drop one user; when the last leaves, tear the room down after a short grace period so a
 *  StrictMode remount or quick re-open reuses the still-synced room instead of resyncing. */
export function releaseYRoom(tabId: ID): void {
  const r = roomCache.get(tabId);
  if (!r) return;
  r.refs = Math.max(0, r.refs - 1);
  if (r.refs === 0 && !r.destroyTimer) {
    r.destroyTimer = setTimeout(() => {
      const cur = roomCache.get(tabId);
      if (cur && cur.refs === 0) {
        cur.provider.destroy();
        cur.doc.destroy();
        roomCache.delete(tabId);
      }
    }, DESTROY_DELAY_MS);
  }
}
