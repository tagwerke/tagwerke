// Minimal IndexedDB wrapper for offline persistence. Two stores:
//   - `kv`     : out-of-line keys → the full app-state snapshot + cached session.
//   - `outbox` : auto-incrementing queue of pending mutations (see outbox.ts).
// Promise-based, dependency-free. All failures are swallowed to undefined/no-op so
// a blocked/absent IndexedDB (private mode, quota) never breaks the online path.

const DB_NAME = 'do-offline';
const DB_VERSION = 1;
export const KV_STORE = 'kv';
export const OUTBOX_STORE = 'outbox';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        let request: IDBRequest<T> | void;
        try {
          const t = db.transaction(store, mode);
          const s = t.objectStore(store);
          request = run(s);
          t.oncomplete = () => resolve(request ? (request as IDBRequest<T>).result : undefined);
          t.onerror = () => resolve(undefined);
          t.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

// ── KV ─────────────────────────────────────────────────────────────────────
export function kvGet<T>(key: string): Promise<T | undefined> {
  return tx<T>(KV_STORE, 'readonly', (s) => s.get(key) as IDBRequest<T>);
}
export function kvSet(key: string, value: unknown): Promise<unknown> {
  return tx(KV_STORE, 'readwrite', (s) => { s.put(value, key); });
}
export function kvDel(key: string): Promise<unknown> {
  return tx(KV_STORE, 'readwrite', (s) => { s.delete(key); });
}

// ── Outbox ───────────────────────────────────────────────────────────────────
export interface OutboxRow<T = unknown> { seq: number; op: T }

/** Append an op; resolves with the assigned auto-increment seq (or undefined if IDB is unavailable). */
export function outboxAdd(op: unknown): Promise<number | undefined> {
  return tx<IDBValidKey>(OUTBOX_STORE, 'readwrite', (s) => s.add({ op }) as IDBRequest<IDBValidKey>)
    .then((k) => (typeof k === 'number' ? k : undefined));
}
export function outboxDelete(seq: number): Promise<unknown> {
  return tx(OUTBOX_STORE, 'readwrite', (s) => { s.delete(seq); });
}
export function outboxAll<T = unknown>(): Promise<OutboxRow<T>[]> {
  return tx<OutboxRow<T>[]>(OUTBOX_STORE, 'readonly', (s) => s.getAll() as IDBRequest<OutboxRow<T>[]>)
    .then((rows) => rows ?? []);
}
export function outboxClear(): Promise<unknown> {
  return tx(OUTBOX_STORE, 'readwrite', (s) => { s.clear(); });
}
