// End-to-end debug logging for the document/CRDT flow (server side). Active unless
// NODE_ENV=production, so `npm run dev` prints the full trace and the deployed instance stays quiet.
// Every line is
//   HH:MM:SS.mmm [srv:<scope>] <msg>  {optional data}
// matching the client's src/util/dlog.ts ([do:*]) so browser + server can be lined up by wall clock.
// Grep server stdout for "[srv:" to isolate this trace. Temporary instrumentation.

// On in dev automatically; in PRODUCTION it's opt-in via the `DO_DEBUG=1` env var (set it in
// Dokploy and restart the service). Keeps the deployed instance quiet by default while letting us
// trace it on demand — the tab-create latency race only reproduces in prod.
const ON = process.env.DO_DEBUG === '1' || process.env.NODE_ENV !== 'production';

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function dlog(scope: string, msg: string, data?: unknown): void {
  if (!ON) return;
  if (data === undefined) console.log(`${ts()} [srv:${scope}] ${msg}`);
  else console.log(`${ts()} [srv:${scope}] ${msg}`, data);
}

/** Short id for readable, correlatable lines (first 6 chars). */
export function sid(id: string | null | undefined): string {
  return id ? id.slice(0, 6) : '—';
}
