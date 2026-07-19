// End-to-end debug logging for the document/CRDT flow (client side). Active ONLY in dev builds
// (import.meta.env.DEV) — a no-op in production, so shipping it is harmless. Every line is
//   HH:MM:SS.mmm [do:<scope>] <msg>  {optional data}
// The wall-clock timestamp lets the browser console and the server stdout ([srv:*]) be correlated
// by time. Grep the console for "[do:" to isolate this trace. Temporary instrumentation — see the
// matching server/lib/dlog.ts.

// On in dev automatically; in PRODUCTION it's opt-in per browser via `localStorage.do_debug = '1'`
// (then reload). That keeps the trace off for normal users while letting us log the prod instance —
// the only place the tab-create latency race actually reproduces. Read once at module load.
function debugOn(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('do_debug') === '1';
  } catch {
    return false; // localStorage blocked (private mode / SSR) → stay quiet
  }
}
const ON = debugOn();

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function dlog(scope: string, msg: string, data?: unknown): void {
  if (!ON) return;
  if (data === undefined) console.log(`${ts()} [do:${scope}] ${msg}`);
  else console.log(`${ts()} [do:${scope}] ${msg}`, data);
}

/** Short tab id for readable, correlatable lines (first 6 chars). */
export function sid(id: string | null | undefined): string {
  return id ? id.slice(0, 6) : '—';
}
