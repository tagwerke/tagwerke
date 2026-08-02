// The notice surface for src/toast/useToast.ts. Rendered once at the App root — never inside a
// panel whose backdrop click would tear it down mid-read — and shares the cascade offer's styling,
// since the two are the same object in the interface with different jobs.

import { useEffect } from 'react';
import { useToast } from '../../toast/useToast';

const DISMISS_MS = 6000;

export function Toast() {
  const message = useToast((s) => s.message);
  const seq = useToast((s) => s.seq);
  const dismiss = useToast((s) => s.dismiss);

  // Times out on its own: a report needs to be seen, not acknowledged. `seq` is in the deps so a
  // repeated identical message restarts the clock instead of inheriting the old one.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(dismiss, DISMISS_MS);
    return () => clearTimeout(t);
  }, [message, seq, dismiss]);

  if (!message) return null;
  return (
    <div className="cascade-toast app-toast" role="status">
      <div className="cascade-toast-text">{message}</div>
      <div className="cascade-toast-actions">
        <button type="button" className="btn-quiet" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
