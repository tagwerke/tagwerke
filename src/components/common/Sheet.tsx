// A drawer / sheet primitive: a right-side drawer on desktop, a bottom sheet on phones
// (CSS switches at the 720px breakpoint). The body always scrolls (max-height + overflow
// baked in) so long content never runs off-screen — the fix for the old centered-modal
// overflow bug. Closes on Escape or backdrop click. Used for the mobile companion rail and
// any panel that outgrows a centered modal.

import { useEffect } from 'react';

export function Sheet({
  title,
  onClose,
  className = '',
  children,
}: {
  title?: React.ReactNode;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop drawer-backdrop" onClick={onClose}>
      <div className={`drawer ${className}`} onClick={(e) => e.stopPropagation()}>
        {title != null && (
          <header className="drawer-head">
            <strong>{title}</strong>
            <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
          </header>
        )}
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
