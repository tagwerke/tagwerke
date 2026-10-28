// The board's ⋯ menu in its title row: the way into board settings, plus the things people expect
// under a ⋯ (history, trash, the link, leaving, deleting). Every item but Copy link opens settings
// at a section, so the menu adds shortcuts, never a second place where something lives.
//
// Drawn with the task menu's classes, and positioned the way TaskActionMenu is: fixed, under the
// button, right edges aligned.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { boardPath } from '../../util/router';
import { showToast } from '../../toast/useToast';
import type { BoardSettingsSection, ID } from '../../types';

/** .task-menu's min-width — these labels never stretch it wider — so the right edges line up. */
const MENU_WIDTH = 210;

export function BoardMenu({ tabId }: { tabId: ID }) {
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const openBoardSettings = useStore((s) => s.openBoardSettings);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setAt(null);
    };
    // Claim the Escape so TabView doesn't take it as "leave the board".
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setAt(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [at]);

  const toggle = (): void => {
    if (at) return setAt(null);
    const box = buttonRef.current!.getBoundingClientRect();
    setAt({ x: Math.max(8, box.right - MENU_WIDTH), y: box.bottom + 4 });
  };

  const go = (section: BoardSettingsSection) => () => {
    setAt(null);
    openBoardSettings(tabId, section);
  };

  async function copyLink(): Promise<void> {
    setAt(null);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${boardPath(tabId)}`);
      showToast('Link copied.');
    } catch {
      showToast('Couldn’t reach the clipboard. The link is in Board settings › General.');
    }
  }

  const items: { label: string; run: () => void; danger?: boolean }[] = [
    { label: 'Board settings', run: go('general') },
    { label: 'History', run: go('history') },
    { label: 'Trash', run: go('trash') },
    { label: 'Copy link', run: () => void copyLink() },
    { label: 'Leave board', run: go('danger') },
    ...(isAdmin ? [{ label: 'Delete board…', run: go('danger'), danger: true }] : []),
  ];

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        onClick={toggle}
        aria-label="board menu"
        aria-haspopup="menu"
        aria-expanded={!!at}
        title="Board menu"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {at && (
        <div ref={menuRef} className="task-menu" role="menu" aria-label="Board" style={{ position: 'fixed', top: at.y, left: at.x, zIndex: 60 }}>
          <ul className="task-menu-list">
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  role="menuitem"
                  className={`task-menu-item ${item.danger ? 'is-danger' : ''}`}
                  onClick={item.run}
                >
                  <span className="task-menu-label">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
