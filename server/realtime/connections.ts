// Live connection registry for the realtime socket layer. The board authorization for a
// document room (ws.ts) is evaluated at ydoc-join and would otherwise be trusted for the whole
// session — so a viewer could keep writing and a removed/demoted member could keep reading and
// writing over an already-open socket until they reconnect. This registry lets the member-
// management routes reach a user's LIVE sockets in-process (single-process, two-container stack —
// no broker needed) and revoke or re-tier access immediately.
//
// It holds no protocol logic: ws.ts owns the socket lifecycle and populates a ConnCtx per
// connection; `applyBoardAccessChange` is the one mutation the HTTP routes call.

import type { WebSocket } from 'ws';
import type { BoardRole } from '../auth/boards.ts';
import { unsubscribe, boardChannel, type Subscriber } from '../lib/bus.ts';
import { ydocLeave } from './ydoc.ts';
import { dlog, sid } from '../lib/dlog.ts';

/** Everything the revocation path needs to reach one live connection. Owned by ws.ts. */
export interface ConnCtx {
  socket: WebSocket;
  sub: Subscriber;
  userId: string;
  // Board doc rooms this connection authenticated into, mapped to the CURRENT role. The role is
  // set at ydoc-join and kept fresh by applyBoardAccessChange, so the ydoc write-gate never has to
  // re-query the DB per frame. A board absent from this map was never joined (authz not passed).
  joinedDocRooms: Map<string, BoardRole>;
}

// userId -> that user's live connections (a user may have several tabs/devices open).
const byUser = new Map<string, Set<ConnCtx>>();

export function registerConn(ctx: ConnCtx): void {
  let set = byUser.get(ctx.userId);
  if (!set) byUser.set(ctx.userId, (set = new Set()));
  set.add(ctx);
}

export function dropConn(ctx: ConnCtx): void {
  const set = byUser.get(ctx.userId);
  if (!set) return;
  set.delete(ctx);
  if (set.size === 0) byUser.delete(ctx.userId);
}

/**
 * Reflect a board-access change onto a user's live sockets, synchronously with the membership
 * write. Called from the member routes (add/role-change/remove) and board delete.
 *   - role === null (removed / board deleted): evict every connection from that board's doc room
 *     (drops its cursors + stops inbound/outbound doc frames) and unsubscribe it from the board's
 *     entity channel, so a non-cooperative client can no longer read or write the board.
 *   - role given (promote/demote): re-tier the cached role on any connection already in the room,
 *     so the next write frame is gated by the new role (a demoted editor keeps read, loses write).
 * A connection that never joined the board's doc room is only affected on removal (its channel
 * subscription, if any, is dropped). Best-effort per connection.
 */
export async function applyBoardAccessChange(
  userId: string,
  tabId: string,
  role: BoardRole | null,
): Promise<void> {
  const set = byUser.get(userId);
  if (!set || set.size === 0) return;
  for (const ctx of set) {
    if (role === null) {
      const wasJoined = ctx.joinedDocRooms.delete(tabId);
      unsubscribe(ctx.sub, boardChannel(tabId)); // stop entity/roster broadcasts for this board
      if (wasJoined) {
        dlog('ws', `revoke board=${sid(tabId)} user=${sid(userId)} → evicting from doc room`);
        await ydocLeave(tabId, ctx.socket); // drop cursors + connection; GCs the room if last out
      }
    } else if (ctx.joinedDocRooms.has(tabId)) {
      dlog('ws', `retier board=${sid(tabId)} user=${sid(userId)} → role=${role}`);
      ctx.joinedDocRooms.set(tabId, role);
    }
  }
}
