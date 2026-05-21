// Zustand `persist` storage adapter backed by the local sidecar.
//
// The browser only ever sees the raw persist blob; the sidecar wraps it with
// `{ lastModified, version, data }` on disk so peer comparisons can stay
// clock-independent of the client.
//
// On first boot, if the sidecar has no state yet, we one-shot migrate from
// the legacy `do-app/v1` localStorage key (if present) and push it up.

import type { StateStorage } from 'zustand/middleware';

const LEGACY_KEY = 'do-app/v1';
const DEBOUNCE_MS = 400;

let pendingValue: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> = Promise.resolve();

async function put(value: string): Promise<void> {
  const r = await fetch('/api/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: value,
  });
  if (!r.ok) throw new Error(`sidecar PUT /state ${r.status}`);
}

function flushNow(): Promise<void> {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (pendingValue == null) return inFlight;
  const value = pendingValue;
  pendingValue = null;
  inFlight = inFlight.then(() => put(value)).catch((e) => {
    console.error('[sidecar storage] flush failed', e);
  });
  return inFlight;
}

if (typeof window !== 'undefined') {
  // sendBeacon would be ideal but only does POST; sidecar accepts PUT.
  // Sync XHR on unload is the reliable shape — payload is tiny.
  window.addEventListener('beforeunload', () => {
    if (pendingValue == null) return;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/state', false);
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.send(pendingValue);
      pendingValue = null;
    } catch {
      /* nothing useful to do during unload */
    }
  });
}

export const sidecarStorage: StateStorage = {
  async getItem(_name) {
    const r = await fetch('/api/state');
    if (r.status === 404) {
      // No state on the sidecar yet — try one-time migration from localStorage.
      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_KEY) : null;
      if (legacy) {
        try {
          await put(legacy);
          console.info('[sidecar storage] migrated legacy localStorage → sidecar');
        } catch (e) {
          console.warn('[sidecar storage] migration push failed', e);
        }
        return legacy;
      }
      return null;
    }
    if (!r.ok) {
      throw new Error(`sidecar GET /state ${r.status} — is "npm run dev" running both processes?`);
    }
    const wrapper = (await r.json()) as { data: unknown };
    return JSON.stringify(wrapper.data);
  },

  setItem(_name, value) {
    pendingValue = value;
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flushNow();
    }, DEBOUNCE_MS);
  },

  async removeItem(_name) {
    // No-op: we don't expose deletion of the canonical state from the client.
    // Use `useStore.getState().reset()` to wipe in-memory; the next setItem will overwrite.
  },
};

export async function flushSidecarWrites(): Promise<void> {
  await flushNow();
}

export interface SidecarHealth {
  ok: boolean;
  peerUrl: string | null;
  hasState: boolean;
  lastModified: number | null;
}

export async function getSidecarHealth(): Promise<SidecarHealth> {
  const r = await fetch('/api/health');
  if (!r.ok) throw new Error(`sidecar /health ${r.status}`);
  return await r.json();
}

export interface SyncResult {
  direction: 'push' | 'pull' | 'in-sync' | 'noop';
  localMs?: number;
  peerMs?: number;
  reason?: string;
}

export async function triggerSync(): Promise<SyncResult> {
  // Flush any pending local writes so we sync the *current* state, not stale.
  await flushSidecarWrites();
  const r = await fetch('/api/sync', { method: 'POST' });
  const body = (await r.json()) as SyncResult & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `sync failed (${r.status})`);
  return body;
}
