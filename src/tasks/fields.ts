// A board's custom fields, for UI code (CUSTOM_FIELDS_PLAN P2.3). What a value may be is in
// shared/fields.ts with the server.

import { useStore } from '../store';
import type { BoardField } from '../../shared/fields';
import type { ID } from '../types';

const NONE: readonly BoardField[] = [];

/** Every live field of the board (hidden included), in position order, as a hook so a component
 *  re-renders when an admin edits them. A board with no fields has none. */
export const useBoardFields = (tabId: ID | null | undefined): readonly BoardField[] =>
  useStore((s) => (tabId ? s.fieldsByBoard[tabId] : undefined) ?? NONE);

export const FIELD_TYPE_LABEL: Record<BoardField['type'], string> = {
  url: 'Link',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  text: 'Text',
};
