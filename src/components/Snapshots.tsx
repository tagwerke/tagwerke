import { useState } from 'react';
import { useStore } from '../store';

export function SnapshotsPanel() {
  const snapshots = useStore((s) => s.snapshots);
  const [open, setOpen] = useState<string | null>(null);
  const list = Object.values(snapshots).sort((a, b) => b.createdAt - a.createdAt);

  if (list.length === 0) return null;

  return (
    <section className="snapshots">
      <header className="snapshots-head">
        <h2>log of done</h2>
        <span className="snapshots-hint">frozen daily plans</span>
      </header>
      <ul className="snapshots-list">
        {list.map((s) => (
          <li key={s.id}>
            <button className="snapshot-row" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="snapshot-date">{s.dateKey}</span>
              <span className="snapshot-time">{new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="snapshot-chevron">{open === s.id ? '▾' : '▸'}</span>
            </button>
            {open === s.id && <pre className="snapshot-body">{s.text}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}
