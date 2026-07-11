// Audit-log "Audit log" tab (embedded in AdminPage). A ServiceNow-style board over the
// append-only audit_log: fixed columns, but every cell value can "show matching" (is) or
// "exclude" (is not), building a chip-based condition filter. Plus an absolute-timestamp
// time-range with quick presets. Keyset-paginated; exports the filtered set as CSV / NDJSON.

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, auditExportUrl, type AuditCondition, type AuditEntry, type AuditField, type AuditParams } from '../api/client';
import { formatTimestamp, timeAgo } from '../util/dates';
import { fieldLabel } from '../util/audit';
import { RecordDrawer, type PreviewTarget } from './RecordDrawer';

// A condition carries an optional client-only display label (e.g. an actor's email for an id);
// stripped to the {field, op, value} wire shape before it hits the API.
type UICondition = AuditCondition & { label?: string };

const FIELD_LABELS: Record<AuditField, string> = {
  actor: 'actor', action: 'action', targetType: 'type', targetId: 'target', scope: 'board', status: 'status', method: 'method',
};
const FILTER_FIELDS = Object.keys(FIELD_LABELS) as AuditField[];

/** Local datetime-input value ("YYYY-MM-DDTHH:mm") for a Date. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** Best-effort human label from a row's payload, for the tombstone when a target is gone. */
function payloadTitle(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const snap = (p.snapshot ?? p.created) as Record<string, unknown> | undefined;
  if (snap && typeof snap === 'object') {
    const s = String(snap.text ?? snap.name ?? '');
    if (s) return s;
  }
  return undefined;
}

/** A filterable cell value: click to "show matching" / "exclude". Non-filterable when value is
 *  null (e.g. a system row with no actor) — then it renders as plain text. */
function AuditValue({
  field, value, label, onAdd, onPreview, className,
}: {
  field: AuditField;
  value: string | null;
  label?: React.ReactNode;
  onAdd: (c: UICondition) => void;
  onPreview?: () => void; // left-click opens the record preview, when this value maps to a record
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (value == null || value === '') return <span className={className}>{label ?? '—'}</span>;
  const displayLabel = typeof label === 'string' ? label : undefined;
  const add = (op: 'is' | 'isnot') => {
    onAdd({ field, op, value, label: displayLabel });
    setOpen(false);
  };
  return (
    <span className={`audit-val ${className ?? ''}`} ref={ref}>
      <button
        className={`audit-val-btn ${onPreview ? 'has-preview' : ''}`}
        title={onPreview ? 'Left-click to preview · right-click to filter' : 'Right-click to filter'}
        // Right-click → the filter menu. Left-click opens the record preview when this value maps
        // to a record (actor/scope/target); otherwise it's a no-op that only stops row expand.
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        onClick={(e) => { e.stopPropagation(); onPreview?.(); }}
      >
        {label ?? value}
      </button>
      {open && (
        <div className="audit-val-menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => add('is')}>Show matching</button>
          <button onClick={() => add('isnot')}>Hide matching</button>
        </div>
      )}
    </span>
  );
}

/** The "+ Add filter" builder — for values not currently on screen. */
function AddFilter({ onAdd }: { onAdd: (c: UICondition) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<AuditField>('action');
  const [op, setOp] = useState<'is' | 'isnot'>('is');
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onAdd({ field, op, value: v });
    setValue('');
    setOpen(false);
  };

  return (
    <div className="audit-addfilter" ref={ref}>
      <button className="audit-chip audit-chip-add" onClick={() => setOpen((o) => !o)}>+ filter</button>
      {open && (
        <div className="audit-addfilter-menu">
          <select value={field} onChange={(e) => setField(e.target.value as AuditField)}>
            {FILTER_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value as 'is' | 'isnot')}>
            <option value="is">is</option>
            <option value="isnot">is not</option>
          </select>
          <input
            autoFocus
            value={value}
            placeholder="value"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          <button className="btn ghost tiny" onClick={submit} disabled={!value.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}

export function AuditView() {
  const [conditions, setConditions] = useState<UICondition[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState<'all' | 'security'>('all');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  // The API params for the current filter state (also used to build the export URLs).
  function params(): AuditParams {
    return {
      conditions: conditions.map(({ field, op, value }) => ({ field, op, value })),
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      category,
    };
  }

  async function load(reset: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.admin.audit({ ...params(), limit: 50, cursor: reset ? undefined : cursor ?? undefined });
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
    // Reload whenever the filter set changes.
  }, [conditions, from, to, category]); // eslint-disable-line react-hooks/exhaustive-deps

  // Add a condition. `is` is exclusive per field (only one value matches); `is not` accumulates.
  const addCondition = (c: UICondition) => {
    setConditions((prev) => {
      let rest = prev.filter((x) => !(x.field === c.field && x.value === c.value));
      if (c.op === 'is') rest = rest.filter((x) => x.field !== c.field);
      return [...rest, c];
    });
  };
  const removeCondition = (i: number) => setConditions((prev) => prev.filter((_, n) => n !== i));

  const preset = (mins: number) => {
    setFrom(toLocalInput(new Date(Date.now() - mins * 60000)));
    setTo('');
  };

  return (
    <div className="audit-view">
      {/* Condition chips + add-filter builder */}
      <div className="audit-chips">
        {conditions.map((c, i) => (
          <span key={`${c.field}:${c.op}:${c.value}`} className={`audit-chip ${c.op === 'isnot' ? 'is-not' : ''}`}>
            <span className="audit-chip-field">{FIELD_LABELS[c.field]}</span>
            <span className="audit-chip-op">{c.op === 'isnot' ? 'is not' : 'is'}</span>
            <span className="audit-chip-value">{c.label ?? c.value}</span>
            <button className="audit-chip-x" title="remove" onClick={() => removeCondition(i)}>×</button>
          </span>
        ))}
        <AddFilter onAdd={addCondition} />
        {conditions.length > 0 && <button className="btn ghost tiny" onClick={() => setConditions([])}>clear</button>}
      </div>

      {/* Time range + presets + category + export */}
      <div className="audit-filters">
        <label className="audit-date"><span>from</span><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="audit-date"><span>to</span><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="audit-presets">
          <button className="btn ghost tiny" onClick={() => preset(60)}>1h</button>
          <button className="btn ghost tiny" onClick={() => preset(60 * 24)}>24h</button>
          <button className="btn ghost tiny" onClick={() => preset(60 * 24 * 7)}>7d</button>
          {(from || to) && <button className="btn ghost tiny" onClick={() => { setFrom(''); setTo(''); }}>clear</button>}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value as 'all' | 'security')}>
          <option value="all">all activity</option>
          <option value="security">security only</option>
        </select>
        <a className="btn ghost" href={auditExportUrl('csv', params())}>CSV</a>
        <a className="btn ghost" href={auditExportUrl('ndjson', params())}>NDJSON</a>
      </div>

      {error && <div className="share-error">{error}</div>}

      <div className="audit-table">
        <div className="audit-row audit-head">
          <span>time</span><span>actor</span><span>action</span><span>target</span><span>status</span>
        </div>
        {entries.map((e) => (
          <div key={e.id} className="audit-row" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
            <span title={timeAgo(e.createdAt)}>{formatTimestamp(e.createdAt)}</span>
            <span>
              <AuditValue
                field="actor" value={e.actorId} label={e.actorEmail ?? e.actorId ?? 'system'} onAdd={addCondition}
                onPreview={e.actorId ? () => setPreview({ type: 'user', id: e.actorId!, fallbackLabel: e.actorEmail ?? undefined }) : undefined}
              />
            </span>
            <span>
              <AuditValue field="action" value={e.action} label={e.action} onAdd={addCondition} className="audit-action" />
            </span>
            <span className="audit-target">
              {e.targetType || e.targetId ? (
                <>
                  <AuditValue field="targetType" value={e.targetType} label={e.targetType ?? '?'} onAdd={addCondition} />
                  {e.targetId && (
                    <>:<AuditValue
                      field="targetId" value={e.targetId} label={e.targetId} onAdd={addCondition}
                      onPreview={e.targetType ? () => setPreview({ type: e.targetType!, id: e.targetId!, scope: e.scopeId ?? undefined, fallbackLabel: payloadTitle(e.payload) }) : undefined}
                    /></>
                  )}
                </>
              ) : '—'}
              {e.scopeId && e.scopeId !== e.targetId && (
                <span className="audit-scope"> · <AuditValue
                  field="scope" value={e.scopeId} label={e.scopeName ?? `tab:${e.scopeId}`} onAdd={addCondition}
                  onPreview={() => setPreview({ type: 'tab', id: e.scopeId!, fallbackLabel: e.scopeName ?? undefined })}
                /></span>
              )}
            </span>
            <span>
              <AuditValue field="status" value={e.status != null ? String(e.status) : null} label={e.status != null ? String(e.status) : ''} onAdd={addCondition} />
            </span>
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

      {preview && (
        <RecordDrawer key={`${preview.type}:${preview.id}:${preview.scope ?? ''}`} target={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
