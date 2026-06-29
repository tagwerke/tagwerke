// Persists the last-known app state + session to IndexedDB so the app can boot
// (and the user can keep editing) with no network. The store is plain serializable
// data (see RootState), so it round-trips via structured clone untouched.

import { kvGet, kvSet, kvDel } from './idb';
import type { RootState } from '../types';
import type { SessionUser } from '../api/client';

const STATE_KEY = 'state';
const USER_KEY = 'user';

export function saveSnapshot(state: RootState): void {
  void kvSet(STATE_KEY, state);
}
export function loadSnapshot(): Promise<RootState | undefined> {
  return kvGet<RootState>(STATE_KEY);
}

export function saveCachedUser(user: SessionUser): void {
  void kvSet(USER_KEY, user);
}
export function loadCachedUser(): Promise<SessionUser | undefined> {
  return kvGet<SessionUser>(USER_KEY);
}

/** Clear cached identity + state on logout so the next user can't see stale data. */
export function clearSnapshot(): void {
  void kvDel(STATE_KEY);
  void kvDel(USER_KEY);
}
