// In-memory pub/sub fan-out for the realtime socket layer (live updates, S1).
//
// Single app process (two-container stack: app + postgres), so the channel registry is a
// plain in-memory Map — no Redis, no external broker. If we ever run multiple app
// processes, this is the one seam that grows a cross-process backplane; nothing else changes.
//
// Channels:
//   board:{tabId}  — content for an open board (task ops, doc-version invalidation, events,
//                    roster/settings). Subscribed on demand when a client opens the board.
//   user:{userId}  — a client's personal feed (board shared/removed, board-list changes).
//                    Subscribed once per connection.
//
// Forward-compat (see internal/planning/CRDT_SEAMS.md): this layer is transport-only and
// knows nothing about message SEMANTICS or the docVersion/409 conflict model. Payloads are
// opaque — a future CRDT (Yjs) update rides the same bus unchanged.

import type { WebSocket } from 'ws';

/** A subscriber connection. `ws` is the raw socket; `channels` is its membership set for
 *  O(1) cleanup on disconnect. */
export interface Subscriber {
  ws: WebSocket;
  userId: string;
  channels: Set<string>;
}

const channels = new Map<string, Set<Subscriber>>();

export function boardChannel(tabId: string): string {
  return `board:${tabId}`;
}

export function userChannel(userId: string): string {
  return `user:${userId}`;
}

export function subscribe(sub: Subscriber, channel: string): void {
  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  set.add(sub);
  sub.channels.add(channel);
}

export function unsubscribe(sub: Subscriber, channel: string): void {
  const set = channels.get(channel);
  if (set) {
    set.delete(sub);
    if (set.size === 0) channels.delete(channel);
  }
  sub.channels.delete(channel);
}

/** Remove a subscriber from every channel it joined (on socket close). */
export function dropSubscriber(sub: Subscriber): void {
  for (const channel of sub.channels) {
    const set = channels.get(channel);
    if (set) {
      set.delete(sub);
      if (set.size === 0) channels.delete(channel);
    }
  }
  sub.channels.clear();
}

/**
 * Fan a message out to every subscriber of a channel. The message is serialized once.
 * `except` skips one subscriber (unused today — echoes are suppressed client-side by
 * idempotent, version-gated apply — but kept for a future server-side sender exclude).
 * Best-effort per socket: a dead/backpressured send never throws into the caller.
 */
export function publish(channel: string, message: unknown, except?: Subscriber): void {
  const set = channels.get(channel);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(message);
  for (const sub of set) {
    if (sub === except) continue;
    try {
      sub.ws.send(data);
    } catch {
      /* best-effort: a broken socket is cleaned up on its own close event */
    }
  }
}

/** Diagnostics: current subscriber count for a channel (0 if none). */
export function subscriberCount(channel: string): number {
  return channels.get(channel)?.size ?? 0;
}
