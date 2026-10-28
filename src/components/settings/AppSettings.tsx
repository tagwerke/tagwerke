// App settings: one modal for the things about you and your app rather than one board — your
// spaces, where the tabs go, and your sign-in security. Built like Board settings (same frame, same
// nav rows, same phone list-then-section), opened from the account menu in the header.

import { useEffect, useState } from 'react';
import { useShell, type AppSettingsSection } from '../shell/useShell';
import { usePhone } from '../../util/usePhone';
import { Section } from '../common/Section';
import { Segmented } from '../common/Segmented';
import { SecurityPanel } from '../SecurityPanel';
import { SpacesSection } from './SpacesSection';

const LABEL: Record<AppSettingsSection, string> = {
  spaces: 'Spaces',
  layout: 'Layout',
  security: 'Security',
};

const GROUPS: { label: string; sections: AppSettingsSection[] }[] = [
  { label: 'Workspace', sections: ['spaces'] },
  { label: 'Appearance', sections: ['layout'] },
  { label: 'Account', sections: ['security'] },
];

function LayoutSection() {
  const layout = useShell((s) => s.layout);
  const setLayout = useShell((s) => s.setLayout);
  return (
    <Section
      title="Layout"
      description="The sidebar and the top bar hold your open tabs and the header. Choose which goes where. Saved in this browser."
    >
      <Segmented
        label="Where the tabs go"
        options={[
          { value: 'tabs-side', label: 'Tabs in the sidebar' },
          { value: 'tabs-top', label: 'Tabs in the top bar' },
        ]}
        value={layout}
        onChange={setLayout}
      />
    </Section>
  );
}

export function AppSettings() {
  const section = useShell((s) => s.appSettings);
  const setAppSettings = useShell((s) => s.setAppSettings);
  const phone = usePhone();
  // On a phone: showing the list of sections, or one section.
  const [inSection, setInSection] = useState(false);

  const close = (): void => setAppSettings(null);

  // Escape closes — in the bubble phase, and only if nothing inside claimed it first (a confirm,
  // the new-space row), so it never closes the modal from under a smaller question.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setAppSettings(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setAppSettings]);

  if (!section) return null;
  const showNav = !phone || !inSection;
  const showSection = !phone || inSection;

  const open = (s: AppSettingsSection): void => {
    setAppSettings(s);
    setInSection(true);
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal-list board-settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          {phone && inSection && (
            <button type="button" className="btn ghost" onClick={() => setInSection(false)}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Settings</span>
            </button>
          )}
          <h2>{phone && inSection ? LABEL[section] : 'Settings'}</h2>
          <button className="icon-btn" onClick={close} aria-label="close">✕</button>
        </header>

        <div className="modal-list-body board-settings-body">
          {showNav && (
            <nav className="board-settings-nav" aria-label="Settings sections">
              {/* A phone has no sidebar, so there is no layout to choose there. */}
              {GROUPS.filter((g) => !(phone && g.sections.includes('layout'))).map((group) => (
                <div key={group.label}>
                  <div className="sidebar-sec-head"><span className="sidebar-sec-label">{group.label}</span></div>
                  <div className="space-list">
                    {group.sections.map((s) => {
                      const on = showSection && s === section;
                      return (
                        <div key={s} className={`space ${on ? 'on' : ''}`}>
                          <button type="button" className="space-main" aria-current={on ? 'page' : undefined} onClick={() => open(s)}>
                            <span className="space-name">{LABEL[s]}</span>
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
              {section === 'spaces' && <SpacesSection />}
              {section === 'layout' && <LayoutSection />}
              {section === 'security' && <SecurityPanel />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
