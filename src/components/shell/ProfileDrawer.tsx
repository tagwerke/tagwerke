// Small popover anchored to the sidebar's account row — houses account-level actions that used to
// live in the top bar (Security, Sign out). Positioning/dismiss mechanics mirror SpaceForm: an
// absolutely-positioned panel inside a `position: relative` wrapper, closed on outside click or
// Escape. It opens upward (`bottom`, not `top`) because the account row sits at the very bottom
// of the sidebar.

import { useEffect, useRef } from 'react';
import { useSession } from '../../session/useSession';
import type { Panel } from '../../App';

export function ProfileDrawer({ email, onOpen, onClose }: { email: string; onOpen: (panel: Panel) => void; onClose: () => void }) {
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const logout = useSession((s) => s.logout);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="profile-drawer" ref={ref}>
      <div className="profile-drawer-head">
        <span className="profile-drawer-email">{email}</span>
      </div>
      <button
        className="profile-drawer-row"
        onClick={() => {
          onOpen('security');
          onClose();
        }}
      >
        <span>Security</span>
        {needs2fa && <span className="nav-dot" aria-label="two-factor not set up" />}
      </button>
      <button
        className="profile-drawer-row danger"
        onClick={() => {
          onClose();
          void logout();
        }}
      >
        Sign out
      </button>
    </div>
  );
}
