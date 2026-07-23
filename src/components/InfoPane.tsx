// A generic auxiliary pane that swaps in for a board's normal content (Doc/List/Kanban/Calendar)
// behind the toolbar's "?" button — deliberately NOT one of those views (it isn't a view of the
// board's task data), and deliberately not stored in the global `boardView` state, so opening it
// can never leave a board stuck showing the wrong thing after closing it.
//
// `kind` is a union of one today ("help") on purpose: this is the generic slot other auxiliary
// content (e.g. a future per-board secrets or timeline pane) would plug into later, each getting
// its own `kind` and its own data layer — the swap mechanism itself doesn't need to change.
//
// Content is layered for a first-time reader (see help/helpContent.ts for the full rationale):
// required basics unfolded up top, the old typed-shortcut reference collapsed under "Go faster",
// and the changelog demoted to the very bottom.

import { useEffect, type ReactNode } from 'react';
import { HELP_BASICS, HELP_DETAILS, HELP_SECTIONS, HELP_UPDATES } from '../help/helpContent';
import { useHelpBadge } from '../help/useHelpBadge';

/** Renders `` `text` `` runs as monospace — the only formatting the help copy ever needs, for
 *  literal keystrokes/examples like `-` or `/due friday`. */
function renderInline(text: string): ReactNode {
  return text.split(/`([^`]+)`/g).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

export function InfoPane({ kind, onClose }: { kind: 'help'; onClose: () => void }) {
  const { markSeen } = useHelpBadge();

  useEffect(() => {
    if (kind === 'help') markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark-as-seen should run once per open, not on every markSeen identity change
  }, [kind]);

  return (
    <div className="info-pane">
      <div className="info-pane-head">
        <h2>How to use Tagwerke</h2>
        <button className="icon-btn" onClick={onClose} aria-label="close">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="info-basics">
        {HELP_BASICS.map((b) => (
          <section className="info-basic" key={b.heading}>
            <h3>{b.heading}</h3>
            {b.body ? <p>{renderInline(b.body)}</p> : null}
            {b.steps ? (
              <ol>
                {b.steps.map((s, i) => <li key={i}>{renderInline(s)}</li>)}
              </ol>
            ) : null}
          </section>
        ))}

        <section className="info-basic">
          <h3>Add details to a task</h3>
          <p>Once a task exists, click into it for more:</p>
          <div className="info-detail-grid">
            {HELP_DETAILS.map((d) => (
              <div className="info-detail" key={d.heading}>
                <div className="info-detail-title">{d.heading}</div>
                <p>{renderInline(d.body)}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <details className="info-go-faster">
        <summary>Go faster <span>(optional)</span></summary>
        <div className="info-pane-sections">
          {HELP_SECTIONS.map((sec) => (
            <section className="info-section" key={sec.title}>
              <h3>{sec.title}</h3>
              <dl>
                {sec.rows.map((r) => (
                  <div className="info-row" key={r.cmd}>
                    <dt>{r.cmd}</dt>
                    <dd>{r.desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </details>

      {HELP_UPDATES.length > 0 && (
        <section className="info-pane-updates info-pane-updates-demoted">
          <h3>What's new</h3>
          {HELP_UPDATES.map((u) => (
            <div className="info-update" key={u.id}>
              <span className="info-update-date">{u.date}</span>
              <div>
                <div className="info-update-title">{u.title}</div>
                <p className="info-update-body">{u.body}</p>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
