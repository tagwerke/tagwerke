// Non-blocking banner shown when a live doc save hit a 409 (someone edited the same board at
// the same moment). The server version was adopted into the editor; the user's version is
// stashed. This offers the choice so nothing is lost silently (C3). See docSync.ts.

import { useDocConflicts, restoreLocalDoc, dismissDocConflict } from './docSync';
import type { ID } from '../types';

export function DocConflictBanner({ tabId }: { tabId: ID }) {
  const conflict = useDocConflicts((s) => s.conflicts[tabId]);
  if (!conflict) return null;

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '8px 12px',
        margin: '0 0 8px',
        borderRadius: 8,
        border: '1px solid var(--warn-border, #d9a441)',
        background: 'var(--warn-bg, #fdf6e3)',
        color: 'var(--warn-fg, #6b5324)',
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, minWidth: 180 }}>
        Someone else edited this board while you were typing. Their version is shown now — your
        version is saved as a draft.
      </span>
      <button type="button" onClick={() => restoreLocalDoc(tabId)} style={btn(true)}>
        Keep mine
      </button>
      <button type="button" onClick={() => dismissDocConflict(tabId)} style={btn(false)}>
        Keep theirs
      </button>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--warn-border, #d9a441)',
    background: primary ? 'var(--warn-fg, #6b5324)' : 'transparent',
    color: primary ? '#fff' : 'var(--warn-fg, #6b5324)',
    cursor: 'pointer',
    fontSize: 13,
  };
}
