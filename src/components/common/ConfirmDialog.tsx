// The single app-wide confirmation dialog. Renders nothing until something calls askConfirm();
// see src/confirm/useConfirm.ts for why this is a store-driven singleton rather than local state.

import { useEffect, useRef } from 'react';
import { useConfirm } from '../../confirm/useConfirm';

export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending);
  const settle = useConfirm((s) => s.settle);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus the confirm button on open, and hand focus back to whatever opened the dialog on close,
  // so a keyboard user isn't dropped at the top of the document. Autofocusing the confirm button
  // is also what makes Enter work without a global key handler (see below).
  useEffect(() => {
    if (!pending) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, [pending]);

  // Escape cancels. Capture phase + stopPropagation because the surfaces that open this dialog
  // listen for keys on document/window themselves (Sheet and TabView close on Escape, App opens
  // search on Ctrl+K) — without it, one Escape would both answer the dialog and close the panel
  // behind it. Enter is deliberately NOT bound here: it would confirm a destructive action even
  // when focus sits on Cancel. The autofocused confirm button handles Enter natively instead.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      settle(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pending, settle]);

  if (!pending) return null;
  const danger = pending.danger !== false;

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={() => settle(false)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-title" id="confirm-title">{pending.title}</h2>
        {pending.body != null && <div className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => settle(false)}>
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => settle(true)}
          >
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
