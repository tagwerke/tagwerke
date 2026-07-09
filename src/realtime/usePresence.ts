// Live presence for an open board, derived from Yjs awareness (which the editor already
// populates via CollaborationCaret with { user: { name, color } }). No new transport — this
// just reads what awareness carries and re-renders on change. Read-only: it does NOT retain
// the room (the editor's retain/release governs the room's lifetime).

import { useEffect, useState } from 'react';
import { acquireYRoom } from './yProvider';
import type { ID } from '../types';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  /** True for the local user (their own cursor). */
  self: boolean;
}

interface AwarenessUser {
  user?: { name?: string; color?: string };
}

export function usePresence(tabId: ID): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const { doc, provider } = acquireYRoom(tabId);
    const read = () => {
      const next: Peer[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        const u = (state as AwarenessUser).user;
        if (!u?.name) return;
        next.push({ clientId, name: u.name, color: u.color ?? '#888', self: clientId === doc.clientID });
      });
      setPeers(next);
    };
    read();
    provider.awareness.on('change', read);
    return () => provider.awareness.off('change', read);
  }, [tabId]);

  return peers;
}
