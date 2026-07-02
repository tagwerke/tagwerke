// Audit-log "Audit log" tab (embedded in AdminPage). Browses the append-only audit_log
// with filters + keyset pagination, and exports the filtered set as CSV / NDJSON. Read-only.

import { useEffect, useState } from 'react';
import { api, ApiError, auditExportUrl, type AuditEntry, type AuditParams } from '../api/client';
import { timeAgo } from '../util/dates';
import { fieldLabel } from '../util/audit';

const EMPTY: AuditParams = { category: 'all' };

/** Render the target as "type:id", falling back to em-dash when neither is known. */
function targetLabel(e: AuditEntry): string {
  if (!e.targetType && !e.targetId) return '—';
  return `${e.targetType ?? '?'}${e.targetId ? `:${e.targetId}` : ''}`;
}

/** A readable payload: field diffs as "field: from → to", plus snapshots/created markers. */
function renderPayload(payload: unknown): React.ReactNode {
  if (payload == null || typeof payload !== 'object') return '(no payload)';
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.changes)) {
    return (
      <div className="audit-changes">
        {(p.changes as { field: string; from: unknown; to: unknown }[]).map((c, i) => (
          <div key={i} className="audit-change">
            <span className="audit-field">{fieldLabel(c.field)}</span>: <span className="audit-from">{fmt(c.from)}</span> → <span className="audit-to">{fmt(c.to)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (p.snapshot) return <div className="audit-change">deleted: {fmt(p.snapshot)}</div>;
  if (p.created) return <div className="audit-change">created: {fmt(p.created)}</div>;
  return <pre className="audit-payload">{JSON.stringify(payload, null, 2)}</pre>;
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function AuditView() {
  const [draft, setDraft] = useState<AuditParams>(EMPTY);
  const [filters, setFilters] = useState<AuditParams>(EMPTY);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load(reset: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.admin.audit({ ...filters, limit: 50, cursor: reset ? undefined : cursor ?? undefined });
      setEntries((prev) => (reset ? res.entries : [...prev, ...res.entries]));
      setCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true);
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => setFilters({ ...draft });

  return (
    <div className="audit-view">
      <div className="audit-filters">
        <input placeholder="action (e.g. login_success)" value={draft.action ?? ''} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        <input placeholder="actor (email or id)" value={draft.actor ?? ''} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
        <label className="audit-date"><span>from</span><input type="date" value={draft.from ?? ''} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="audit-date"><span>to</span><input type="date" value={draft.to ?? ''} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <select value={draft.category ?? 'all'} onChange={(e) => setDraft({ ...draft, category: e.target.value as 'all' | 'security' })}>
          <option value="all">all activity</option>
          <option value="security">security only</option>
        </select>
        <button className="btn ghost" disabled={busy} onClick={apply}>Apply</button>
        <a className="btn ghost" href={auditExportUrl('csv', filters)}>CSV</a>
        <a className="btn ghost" href={auditExportUrl('ndjson', filters)}>NDJSON</a>
      </div>

      {error && <div className="share-error">{error}</div>}

      <div className="audit-table">
        <div className="audit-row audit-head">
          <span>time</span><span>actor</span><span>action</span><span>target</span><span>status</span>
        </div>
        {entries.map((e) => (
          <div key={e.id} className="audit-row" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
            <span title={e.createdAt}>{timeAgo(e.createdAt)}</span>
            <span>{e.actorEmail ?? (e.actorId ? e.actorId : 'system')}</span>
            <span className="audit-action">{e.action}</span>
            <span className="audit-target" title={e.scopeId ? `on tab:${e.scopeId}` : undefined}>
              {targetLabel(e)}
              {e.scopeId && e.scopeId !== e.targetId ? <span className="audit-scope"> · tab:{e.scopeId}</span> : null}
            </span>
            <span>{e.status ?? ''}</span>
            {expanded === e.id && <div className="audit-payload">{renderPayload(e.payload)}</div>}
          </div>
        ))}
        {!entries.length && !busy && <div className="share-empty">No matching entries.</div>}
      </div>

      <div className="audit-foot">
        {cursor ? (
          <button className="btn ghost" disabled={busy} onClick={() => void load(false)}>{busy ? 'Loading…' : 'Load more'}</button>
        ) : (
          <span className="audit-end">{busy ? 'Loading…' : 'End of log'}</span>
        )}
      </div>
    </div>
  );
}
