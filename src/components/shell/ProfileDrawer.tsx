// Small popover anchored to the header's account button — houses account-level actions: Settings
// (spaces, layout, security) and Sign out. An absolutely-positioned panel inside a `position:
// relative` wrapper, closed on outside click or Escape. It opens upward when the header is the
// sidebar (the account sits at its very bottom) and downward when the header is the top bar.

import { useEffect, useRef } from 'react';
import { useSession } from '../../session/useSession';
import { confirmSignOut } from '../../confirm/prompts';
import { useConfirm } from '../../confirm/useConfirm';
import { useShell } from './useShell';

export function ProfileDrawer({ email, below, onClose }: { email: string; below?: boolean; onClose: () => void }) {
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const logout = useSession((s) => s.logout);
  const setAppSettings = useShell((s) => s.setAppSettings);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The confirm dialog lives outside this popover, so a click in it must not read as an
      // outside click and close the drawer under a pending question.
      if (useConfirm.getState().pending) return;
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
    <div className={`profile-drawer ${below ? 'is-below' : ''}`} ref={ref}>
      <div className="profile-drawer-head">
        <span className="profile-drawer-email">{email}</span>
      </div>
      <button
        className="profile-drawer-row"
        onClick={() => {
          setAppSettings(needs2fa ? 'security' : 'spaces');
          onClose();
        }}
      >
        <span>Settings</span>
        {needs2fa && <span className="nav-dot" aria-label="two-factor not set up" />}
      </button>
      <button
        className="profile-drawer-row danger"
        onClick={() => {
          void confirmSignOut().then((ok) => {
            if (!ok) return;
            onClose();
            void logout();
          });
        }}
      >
        Sign out
      </button>
    </div>
  );
}
