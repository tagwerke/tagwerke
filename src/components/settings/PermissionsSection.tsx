// Board settings › Permissions: what each role can do here, and the one rule an admin can change
// about it (who may delete tasks). Roles themselves are given to people in People.
//
// The role lines describe what the server enforces, not a policy of their own: viewers read and
// comment, editors work on tasks (deleting them unless the rule below says otherwise) and restore
// from Trash, admins manage people, task states, guardrails, secrets and the board itself.

import { useStore } from '../../store';
import { Section } from '../common/Section';
import type { ID } from '../../types';

export function PermissionsSection({ tabId }: { tabId: ID }) {
  const settings = useStore((s) => s.tabs[tabId]?.settings);
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const setTabSettings = useStore((s) => s.setTabSettings);
  const openBoardSettings = useStore((s) => s.openBoardSettings);
  const adminsOnly = settings?.restrictDelete === 'admin';

  const roles = [
    { role: 'viewer', text: 'Sees the board’s tasks, notes and files, and comments on tasks.' },
    {
      role: 'editor',
      text: adminsOnly
        ? 'Everything a viewer can, plus creating and editing tasks, notes and sprints, and restoring tasks from Trash.'
        : 'Everything a viewer can, plus creating and editing tasks, notes and sprints, deleting tasks, and restoring them from Trash.',
    },
    { role: 'admin', text: 'Everything an editor can, plus inviting people, changing roles, editing task states, deleting sprints, opening secrets and deleting the board.' },
  ];

  return (
    <>
      <Section
        title="Roles"
        description={<>What each role can do on this board. You give someone a role in <button type="button" className="link-btn" onClick={() => openBoardSettings(tabId, 'people')}>People</button>.</>}
      >
        <ul className="share-members">
          {roles.map((r) => (
            <li key={r.role} className="list-row">
              <span className="share-role">{r.role}</span>
              <p className="section-desc">{r.text}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Deleting tasks" description="Deleted tasks go to Trash, where an editor can restore them.">
        <label className="board-setting">
          <input
            type="checkbox"
            checked={adminsOnly}
            disabled={!isAdmin}
            onChange={(e) => setTabSettings(tabId, { ...settings, restrictDelete: e.target.checked ? 'admin' : undefined })}
          />
          Only admins can delete tasks
        </label>
        {!isAdmin && <p className="section-desc">Only board admins can change this.</p>}
      </Section>
    </>
  );
}
