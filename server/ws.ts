// Realtime socket layer (live updates, S1). One authenticated WebSocket per client on the
// same Fastify instance/port; the bundled Caddy proxies the Upgrade transparently and the
// existing session cookie authenticates it — nothing leaves the box, install stays a
// two-container stack.
//
// This file owns connection lifecycle + subscription routing ONLY. It is deliberately
// ignorant of message semantics and of the docVersion/409 conflict model (that lives in the
// HTTP routes). Forward-compat rules — see internal/planning/CRDT_SEAMS.md:
//   1. Every message is an open, versioned envelope { v, type, ... }; unknown types are ignored.
//   2. Binary frames are accepted (ignored today) so a future Yjs update rides the same socket.
//   3. Conflict logic stays OUT of here.
//   4. `subscribe` is request→response (acked), matching a future CRDT sync handshake.

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import websocketPlugin from '@fastify/websocket';
import { resolveUser } from './auth/session.ts';
import { boardRole } from './auth/boards.ts';
import { isContentRoute, targetTypeForPath } from './lib/audit.ts';
import {
  boardChannel,
  userChannel,
  subscribe,
  unsubscribe,
  dropSubscriber,
  publish,
  type Subscriber,
} from './lib/bus.ts';
import { ydocJoin, ydocMessage, ydocLeave, ydocDropConnection } from './realtime/ydoc.ts';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 30_000;

function send(ws: WebSocket, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* best-effort */
  }
}

/**
 * Live-updates broadcast (S2). One onResponse hook that fans every successful board
 * mutation out to the board channel. Deliberately SEPARATE from the audit hook: content
 * routes (tasks/events/…) call auditEdit() which sets req.auditHandled and makes the audit
 * hook bail early — so a broadcast living there would never fire for the high-value routes.
 *
 * Entity writes carry the request body as a directly-appliable patch. Tab writes are skipped
 * here: the document is broadcast explicitly from tabs.ts as a version invalidation (we never
 * fan the whole docJSON blob out). Envelope is open+versioned; clients ignore what they don't
 * handle. req.boardScope + req.user are set by the requireBoardRole/requireAuth preHandlers.
 */
function registerBroadcastHook(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (reply.statusCode >= 400) return;
    if (!req.user?.id || !req.boardScope) return;
    const path = req.url.split('?')[0];
    const entity = targetTypeForPath(path);
    if (!entity || entity === 'tab') return; // tab doc handled explicitly in tabs.ts
    publish(boardChannel(req.boardScope), {
      v: PROTOCOL_VERSION,
      type: 'entity',
      entity,
      id: (req.params as { id?: string } | undefined)?.id ?? null,
      action: req.method,
      patch: isContentRoute(path) ? req.body ?? null : null,
      actorId: req.user.id,
    });
  });
}

export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  registerBroadcastHook(app);
  await app.register(websocketPlugin);

  app.get('/api/ws', { websocket: true }, async (socket, req) => {
    // Authenticate off the same signed session cookie the HTTP API uses. The Upgrade
    // request carries cookies (fastify/cookie is registered), so this is the normal path.
    const user = await resolveUser(req);
    if (!user) {
      send(socket, { v: PROTOCOL_VERSION, type: 'error', code: 'unauthenticated' });
      socket.close(1008, 'unauthenticated');
      return;
    }

    const sub: Subscriber = { ws: socket, userId: user.id, channels: new Set() };
    // Board doc rooms this connection has authenticated into (ydoc-join). A 'ydoc' frame is
    // only processed for a board already in this set, so authz is checked once at join.
    const joinedDocRooms = new Set<string>();
    // Personal feed: board-list / membership changes for boards not currently open.
    subscribe(sub, userChannel(user.id));
    send(socket, { v: PROTOCOL_VERSION, type: 'ready', userId: user.id });

    // Liveness: proxies drop idle sockets, and a half-open connection would leak a
    // subscriber. Ping on an interval; a socket that misses a pong is terminated (its
    // close handler runs dropSubscriber).
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* terminated below on close */
      }
    }, HEARTBEAT_MS);

    // Frames are handled one-at-a-time in arrival order. This matters for CRDT: `ydoc-join`
    // does an async room load, and the client's `syncStep1` arrives right behind it — if the
    // two async handlers interleaved, the join might not have registered the connection yet and
    // the sync frame would be dropped (no syncStep2 reply → client never reaches 'synced' →
    // legacy seeding never fires). Serializing per connection removes that race entirely.
    let queue: Promise<void> = Promise.resolve();
    const handleFrame = async (raw: unknown, isBinary: boolean): Promise<void> => {
      // Rule 2: binary is reserved for future opaque (CRDT) payloads — accept, ignore now.
      if (isBinary) return;

      let msg: { type?: string; boardId?: string; data?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // malformed frame — ignore
      }

      switch (msg.type) {
        case 'subscribe': {
          const boardId = msg.boardId;
          if (!boardId) return;
          // Same membership check the HTTP routes use; a non-member cannot join the channel.
          const role = await boardRole(user.id, boardId);
          if (!role) {
            send(socket, { v: PROTOCOL_VERSION, type: 'error', code: 'forbidden', boardId });
            return;
          }
          subscribe(sub, boardChannel(boardId));
          send(socket, { v: PROTOCOL_VERSION, type: 'subscribed', boardId }); // Rule 4: ack
          return;
        }
        case 'unsubscribe': {
          const boardId = msg.boardId;
          if (!boardId) return;
          unsubscribe(sub, boardChannel(boardId));
          send(socket, { v: PROTOCOL_VERSION, type: 'unsubscribed', boardId });
          return;
        }
        // CRDT co-editing (see server/realtime/ydoc.ts + CRDT_SEAMS.md). Joining a doc room is
        // gated by the SAME board membership check as `subscribe`; the Yjs sync/awareness frames
        // themselves ride `ydoc` and are opaque to this layer (conflict logic stays out — Rule 3).
        case 'ydoc-join': {
          const boardId = msg.boardId;
          if (!boardId) return;
          const role = await boardRole(user.id, boardId);
          if (!role) {
            send(socket, { v: PROTOCOL_VERSION, type: 'error', code: 'forbidden', boardId });
            return;
          }
          joinedDocRooms.add(boardId);
          await ydocJoin(boardId, socket);
          return;
        }
        case 'ydoc': {
          const boardId = msg.boardId;
          if (!boardId || typeof msg.data !== 'string') return;
          if (!joinedDocRooms.has(boardId)) return; // must ydoc-join (authz) first
          await ydocMessage(boardId, socket, msg.data);
          return;
        }
        case 'ydoc-leave': {
          const boardId = msg.boardId;
          if (!boardId) return;
          joinedDocRooms.delete(boardId);
          await ydocLeave(boardId, socket);
          return;
        }
        case 'ping':
          send(socket, { v: PROTOCOL_VERSION, type: 'pong' });
          return;
        default:
          return; // Rule 1: unknown type — ignore (forward-compatible)
      }
    };
    socket.on('message', (raw: unknown, isBinary: boolean) => {
      queue = queue.then(() => handleFrame(raw, isBinary)).catch(() => {
        /* one bad frame must not break the chain for the rest of the connection */
      });
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      dropSubscriber(sub);
      void ydocDropConnection(socket); // leave every Yjs room, drop this peer's cursors
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
