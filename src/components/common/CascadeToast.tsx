// "You marked a parent done — its sub-tasks are still open. Sweep them too?" (SUBTASKS_PLAN D5)
//
// Deliberately NOT a modal. A parent's status is its owner's to set, and a deliverable can
// legitimately be done while a follow-up sits open beneath it — so the status change already
// happened and this only offers to finish the job. Blocking it would also route around the
// requireReview approval gate, which is the one thing the accountability layer must not lose.
//
// It is what keeps a completed parent honest without deriving its status from its children.

import { useEffect } from 'react';
import { useStore } from '../../store';

const DISMISS_MS = 12000;

export function CascadeToast() {
  const pending = useStore((s) => s.pendingCascade);
  const applyCascadeDone = useStore((s) => s.applyCascadeDone);
  const dismissCascade = useStore((s) => s.dismissCascade);
  const label = useStore((s) => (s.pendingCascade ? s.tasks[s.pendingCascade.taskId]?.text : undefined));

  // Time out on its own: an unanswered offer is a decline, not a decision to nag about.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(dismissCascade, DISMISS_MS);
    return () => clearTimeout(t);
  }, [pending, dismissCascade]);

  if (!pending) return null;
  const n = pending.count;

  return (
    <div className="cascade-toast" role="status">
      <div className="cascade-toast-text">
        <strong>{label || 'Task'}</strong> is done, but {n} sub-task{n === 1 ? '' : 's'} {n === 1 ? 'is' : 'are'} still open.
      </div>
      <div className="cascade-toast-actions">
        <button type="button" className="btn-quiet" onClick={dismissCascade}>
          Leave {n === 1 ? 'it' : 'them'}
        </button>
        <button type="button" className="btn-solid" onClick={applyCascadeDone}>
          Mark {n === 1 ? 'it' : 'all'} done
        </button>
      </div>
    </div>
  );
}
