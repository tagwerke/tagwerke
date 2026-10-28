// A board's settings: one modal for everything about a board that is not its work — people, roles,
// task states, sprints, history, trash, secrets access, leaving and deleting. The board itself only
// links in (Share, the ⋯ menu, the pickers' "Edit states…" / "Manage sprints…" / "Invite someone…",
// search), and every link lands on a section here, so each thing about a board has one home.
//
// The open section is the store's `boardSettings`, which the URL mirrors (/b/:id/settings/:section).
// The nav reuses the sidebar's own rows. On a phone the nav and a section don't fit side by side,
// so the nav is a list you tap into, with a way back to it.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { usePhone } from '../../util/usePhone';
import { ActivityDrawer } from '../ActivityDrawer';
import { MembersPanel } from '../MembersPanel';
import { SprintsPage } from '../SprintsPage';
import { TrashPanel } from '../TrashPanel';
import { BoardStatesPanel } from '../states/BoardStatesPanel';
import { Section } from '../common/Section';
import { GeneralSection } from './GeneralSection';
import { PermissionsSection } from './PermissionsSection';
import { SecretsAccessSection } from './SecretsAccessSection';
import { DangerSection } from './DangerSection';
import { ADMIN_ONLY_SECTIONS, SECTION_GROUPS, SECTION_LABEL } from './sections';
import type { BoardSettingsSection, ID } from '../../types';

export function BoardSettings({ tabId, onOpenSprint }: {
  tabId: ID;
  /** Close settings onto the table, filtered to a sprint or (`null`) the backlog. */
  onOpenSprint: (sprintId: ID | null) => void;
}) {
  const tab = useStore((s) => s.tabs[tabId]);
  const requested = useStore((s) => s.boardSettings);
  const setBoardSettings = useStore((s) => s.setBoardSettings);
  const phone = usePhone();
  // On a phone: showing the list of sections, or one section. A link that names a section opens on
  // it; opening settings themselves (General, the first entry) opens on the list.
  const [inSection, setInSection] = useState(() => requested !== 'general');

  const close = (): void => setBoardSettings(null);

  // Escape closes settings — in the bubble phase, and claiming the key, so a dialog opened on top
  // (a confirm, the network policy) closes first, and TabView doesn't take it as "leave the board".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setBoardSettings(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setBoardSettings]);

  if (!tab || !requested) return null;
  const isAdmin = tab.role === 'admin';
  // A non-admin who lands on an admin-only section (an old link, a role just lowered) gets General.
  const section: BoardSettingsSection = ADMIN_ONLY_SECTIONS.includes(requested) && !isAdmin ? 'general' : requested;
  const showNav = !phone || !inSection;
  const showSection = !phone || inSection;

  const open = (s: BoardSettingsSection): void => {
    setBoardSettings(s);
    setInSection(true);
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal-list board-settings-modal" role="dialog" aria-modal="true" aria-label="Board settings" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          {phone && inSection && (
            <button type="button" className="btn ghost" onClick={() => setInSection(false)}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Settings</span>
            </button>
          )}
          <h2>
            {phone && inSection ? SECTION_LABEL[section] : 'Board settings'}{' '}
            <span className="modal-head-sub">{tab.name}</span>
          </h2>
          <button className="icon-btn" onClick={close} aria-label="close">✕</button>
        </header>

        <div className="modal-list-body board-settings-body">
          {showNav && (
            <nav className="board-settings-nav" aria-label="Settings sections">
              {SECTION_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="sidebar-sec-head"><span className="sidebar-sec-label">{group.label}</span></div>
                  <div className="space-list">
                    {group.sections
                      .filter((s) => isAdmin || !ADMIN_ONLY_SECTIONS.includes(s))
                      .map((s) => {
                        const on = showSection && s === section;
                        return (
                          <div key={s} className={`space ${on ? 'on' : ''}`}>
                            <button type="button" className="space-main" aria-current={on ? 'page' : undefined} onClick={() => open(s)}>
                              <span className="space-name">{SECTION_LABEL[s]}</span>
                            </button>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </nav>
          )}

          {showSection && (
            <div className="board-settings-section">
              {section === 'general' && <GeneralSection tabId={tabId} />}
              {section === 'people' && <MembersPanel tabId={tabId} tabName={tab.name} />}
              {section === 'permissions' && <PermissionsSection tabId={tabId} />}
              {section === 'states' && (
                <Section title="Task states">
                  <BoardStatesPanel tabId={tabId} />
                </Section>
              )}
              {section === 'sprints' && (
                <Section title="Sprints">
                  <SprintsPage tabId={tabId} onOpenSprint={onOpenSprint} />
                </Section>
              )}
              {section === 'history' && (
                <ActivityDrawer kind="tab" id={tabId} boardId={tabId} title={tab.name} embedded onClose={close} />
              )}
              {section === 'trash' && (
                <Section title="Trash" description="Deleted tasks wait here until someone restores them.">
                  <TrashPanel tabId={tabId} />
                </Section>
              )}
              {section === 'secrets' && <SecretsAccessSection tabId={tabId} />}
              {section === 'danger' && <DangerSection tabId={tabId} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
