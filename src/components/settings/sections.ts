// The sections of a board's settings, defined once: the modal's nav reads the groups, and the search
// palette reads the search terms, so a section cannot be findable under a name the nav doesn't use.

import type { BoardSettingsSection } from '../../types';

export const SECTION_LABEL: Record<BoardSettingsSection, string> = {
  general: 'General',
  people: 'People',
  permissions: 'Permissions',
  states: 'Task states',
  sprints: 'Sprints',
  history: 'History',
  trash: 'Trash',
  secrets: 'Secrets access',
  danger: 'Danger zone',
};

/** The nav, in order. Secrets access is board-admin only, like the Secrets view it guards. */
export const SECTION_GROUPS: { label: string; sections: BoardSettingsSection[] }[] = [
  { label: 'Board', sections: ['general', 'people', 'permissions'] },
  { label: 'Work', sections: ['states', 'sprints'] },
  { label: 'Records', sections: ['history', 'trash'] },
  { label: 'Admin', sections: ['secrets', 'danger'] },
];

export const ADMIN_ONLY_SECTIONS: BoardSettingsSection[] = ['secrets'];

/**
 * What a person might type to find a setting, mapped to where it lives. Written as the words people
 * use ("bin", "share", "workflow"), not the ones the code uses — that is the whole point of letting
 * search reach settings.
 */
export const SETTINGS_SEARCH: { label: string; section: BoardSettingsSection; terms: string; adminOnly?: boolean }[] = [
  { label: 'Invite people', section: 'people', terms: 'share invite add member people user access email collaborator' },
  { label: 'Change someone’s role', section: 'people', terms: 'role admin editor viewer remove member' },
  { label: 'Add an agent', section: 'people', terms: 'agent bot api token key integration automation' },
  { label: 'Roles and permissions', section: 'permissions', terms: 'permission role rights access who can delete' },
  { label: 'Task states', section: 'states', terms: 'status state workflow column done category stage pipeline' },
  { label: 'Sprints', section: 'sprints', terms: 'sprint week backlog current iteration cycle' },
  { label: 'Board history', section: 'history', terms: 'history log changes audit who changed timeline activity' },
  { label: 'Trash', section: 'trash', terms: 'trash bin deleted restore undo recover recycle' },
  { label: 'Rename the board', section: 'general', terms: 'rename name title' },
  { label: 'Move to another space', section: 'general', terms: 'project space move folder' },
  { label: 'Copy the board link', section: 'general', terms: 'link url copy' },
  { label: 'Networks that can open secrets', section: 'secrets', terms: 'secret network ip allowlist vpn password credential vault', adminOnly: true },
  { label: 'Leave the board', section: 'danger', terms: 'leave exit quit' },
  { label: 'Delete the board', section: 'danger', terms: 'delete remove destroy board', adminOnly: true },
];
