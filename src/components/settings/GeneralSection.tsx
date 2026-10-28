// Board settings › General: the board's name, the space it's filed in, and its link. The name and
// space are the same writes the board's own title row makes; this is where they are found by name.

import { useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { boardPath } from '../../util/router';
import { showToast } from '../../toast/useToast';
import { Dropdown } from '../Dropdown';
import { Section } from '../common/Section';
import type { ID } from '../../types';

export function GeneralSection({ tabId }: { tabId: ID }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const projects = useStore((s) => s.projects);
  const renameTab = useStore((s) => s.renameTab);
  const setTabProject = useStore((s) => s.setTabProject);
  const projectOptions = useMemo(
    () => Object.values(projects)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ value: p.id, label: p.name, accent: p.color })),
    [projects],
  );
  // As in the title row: a board must have a name, so an emptied field puts back the name it had.
  const nameOnFocus = useRef(tab?.name ?? '');

  if (!tab) return null;
  const link = `${window.location.origin}${boardPath(tabId)}`;

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link copied.');
    } catch {
      showToast('Couldn’t reach the clipboard. Select the link and copy it by hand.');
    }
  }

  return (
    <Section title="General">
      <label className="field">
        <span>Board name</span>
        <input
          value={tab.name}
          onFocus={() => { nameOnFocus.current = tab.name; }}
          onChange={(e) => renameTab(tab.id, e.target.value)}
          onBlur={() => { if (!tab.name.trim()) renameTab(tab.id, nameOnFocus.current); }}
        />
      </label>
      {projectOptions.length > 0 && (
        <div className="field">
          <span>Space</span>
          <Dropdown value={tab.projectId} options={projectOptions} onChange={(id) => setTabProject(tab.id, id)} placeholder="Space" />
        </div>
      )}
      <label className="field">
        <span>Board link</span>
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <p className="section-desc">Only people on this board can open it.</p>
      <button type="button" className="btn ghost tiny security-act" onClick={() => void copyLink()}>Copy link</button>
    </Section>
  );
}
